import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../lib/logger.js";
import { emitScreenshot, emitStatus, emitLog, clearScreenshotCache } from "../lib/socket.js";

const execFileAsync = promisify(execFile);

export type BotState =
  | "idle"
  | "logging_in"
  | "navigating"
  | "active"
  | "error"
  | "stopped";

export interface BotLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface BotStatus {
  running: boolean;
  state: BotState;
  uptimeSeconds: number;
  startedAt: string | null;
  currentUrl: string | null;
  lastReloadAt: string | null;
  reloadCount: number;
  errorMessage: string | null;
}

export interface BotScreenshot {
  data: string | null;
  capturedAt: string | null;
}

export interface DiagnosticInfo {
  nodeVersion: string;
  chromeBinary: string | null;
  chromeVersion: string | null;
  xvfbAvailable: boolean;
  display: string;
  platform: string;
  arch: string;
}

const RELOAD_INTERVAL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 30_000;

const CHROME_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--window-size=1280,720",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-client-side-phishing-detection",
  "--disable-sync",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-blink-features=AutomationControlled",
];

const CF_PAGE_SELECTORS = [
  "#challenge-running",
  "#challenge-stage",
  "#challenge-form",
  ".cf-browser-verification",
  "#cf-challenge-running",
  "input[name='cf_captcha_kind']",
];

const CF_TURNSTILE_IFRAME_SELECTORS = [
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='cloudflare.com/cdn-cgi/challenge-platform']",
  "iframe[title*='cloudflare']",
];

const CF_CHECKBOX_SELECTORS = [
  "input[type='checkbox']",
  ".ctp-checkbox-label",
  ".cb-lb",
  "[id^='cf-chl-widget']",
  "label[for^='cf-']",
  ".mark",
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isBinaryValid(binPath: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ["--version"], { timeout: 5000 });
    const output = (stdout + stderr).toLowerCase();
    if (
      output.includes("snap") ||
      output.includes("requires the chromium snap") ||
      output.includes("snap install") ||
      output.trim() === ""
    ) {
      return false;
    }
    return true;
  } catch (err: any) {
    const msg: string = (err?.message ?? String(err)).toLowerCase();
    if (msg.includes("snap") || msg.includes("requires the chromium snap")) {
      return false;
    }
    return false;
  }
}

async function findChromeBinary(): Promise<string | null> {
  const candidates = [
    "google-chrome-stable",
    "google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "chromium",
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
  ];
  for (const bin of candidates) {
    let resolvedPath: string | null = null;
    try {
      resolvedPath = await which(bin);
    } catch {}
    if (!resolvedPath) {
      try {
        await execFileAsync("test", ["-x", bin], { timeout: 2000 });
        resolvedPath = bin;
      } catch {}
    }
    if (resolvedPath && await isBinaryValid(resolvedPath)) {
      return resolvedPath;
    }
  }
  return null;
}

export async function diagnose(): Promise<DiagnosticInfo> {
  const chromeBinary = await findChromeBinary();
  let chromeVersion: string | null = null;
  if (chromeBinary) {
    try {
      const { stdout } = await execFileAsync(chromeBinary, ["--version"]);
      chromeVersion = stdout.trim();
    } catch {}
  }
  const xvfbPath = await which("Xvfb");
  return {
    nodeVersion: process.version,
    chromeBinary,
    chromeVersion,
    xvfbAvailable: xvfbPath !== null,
    display: process.env["DISPLAY"] ?? "(not set)",
    platform: process.platform,
    arch: process.arch,
  };
}

let browserInstance: any = null;
let pageInstance: any = null;
let state: BotState = "stopped";
let startedAt: Date | null = null;
let lastReloadAt: Date | null = null;
let reloadCount = 0;
let errorMessage: string | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let lastScreenshot: BotScreenshot = { data: null, capturedAt: null };
const auditLog: BotLogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function addLog(level: BotLogEntry["level"], message: string) {
  const entry: BotLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  auditLog.unshift(entry);
  if (auditLog.length > MAX_LOG_ENTRIES) auditLog.length = MAX_LOG_ENTRIES;
  logger.info({ level, message }, "[bot] %s", message);
  emitLog(entry);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isCloudflareChallenge(page: any): Promise<boolean> {
  try {
    const title: string = await page.title();
    if (title.toLowerCase().includes("just a moment") || title.toLowerCase().includes("attention required")) {
      return true;
    }
    for (const sel of CF_PAGE_SELECTORS) {
      const el = await page.$(sel);
      if (el) return true;
    }
    const frames: any[] = page.frames();
    for (const frame of frames) {
      const frameUrl: string = frame.url();
      if (frameUrl.includes("challenges.cloudflare.com") || frameUrl.includes("cloudflare.com/cdn-cgi/challenge-platform")) {
        return true;
      }
    }
  } catch {}
  return false;
}

function getAllFrames(page: any): any[] {
  try {
    return page.frames() ?? [];
  } catch {
    return [];
  }
}

function isCfFrame(url: string): boolean {
  return (
    url.includes("challenges.cloudflare.com") ||
    url.includes("cloudflare.com/cdn-cgi/challenge-platform") ||
    url.includes("cloudflare.com/cdn-cgi/turnstile")
  );
}

async function tryCfClickInFrame(frame: any): Promise<boolean> {
  for (const sel of CF_CHECKBOX_SELECTORS) {
    try {
      const el = await frame.$(sel);
      if (!el) continue;
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await el.click();
        return true;
      }
    } catch {}
  }
  try {
    const body = await frame.$("body");
    if (body) {
      const box = await body.boundingBox();
      if (box && box.width > 10 && box.height > 10) {
        await frame.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    }
  } catch {}
  return false;
}

async function tryCfClickOnMainPage(page: any): Promise<boolean> {
  const mainPageSelectors = [
    "#challenge-form input[type='button']",
    "#challenge-form input[type='submit']",
    "#challenge-stage input[type='button']",
    "#challenge-stage input[type='submit']",
    "input[value='Verify you are human']",
    "input[value='Submit']",
    ".ctp-checkbox-label",
    ".cb-lb",
    "[data-translate='verifyButton']",
  ];
  for (const sel of mainPageSelectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await el.click();
        return true;
      }
    } catch {}
  }

  for (const ifrSel of CF_TURNSTILE_IFRAME_SELECTORS) {
    try {
      const ifrEl = await page.$(ifrSel);
      if (!ifrEl) continue;
      const box = await ifrEl.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    } catch {}
  }
  return false;
}

async function simulateHumanMouse(page: any): Promise<void> {
  try {
    // Move mouse in a natural curve across the viewport
    const steps = [
      { x: 100, y: 200 }, { x: 300, y: 150 }, { x: 500, y: 300 },
      { x: 640, y: 360 }, { x: 800, y: 250 }, { x: 640, y: 400 },
    ];
    for (const { x, y } of steps) {
      await page.mouse.move(x, y, { steps: 10 });
      await sleep(80 + Math.floor(Math.random() * 120));
    }
  } catch {}
}

async function handleCloudflareChallenge(page: any): Promise<boolean> {
  const onChallenge = await isCloudflareChallenge(page);
  if (!onChallenge) return true;

  let title = "unknown";
  let url = "unknown";
  try { title = await page.title(); } catch {}
  try { url = page.url(); } catch {}

  addLog("warn", `Cloudflare challenge detected — Page: "${title}" at ${url}`);
  await captureScreenshot();

  // Simulate human presence before anything else
  await simulateHumanMouse(page);

  // Phase 1: Wait up to 30 seconds for JS auto-resolve, screenshot every 5s
  addLog("info", "Waiting for Cloudflare JS challenge to auto-resolve (up to 30s)...");
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (i % 5 === 4) await captureScreenshot();
    const still = await isCloudflareChallenge(page);
    if (!still) {
      addLog("success", `Cloudflare auto-resolved after ${i + 1}s`);
      await captureScreenshot();
      return true;
    }
  }

  await captureScreenshot();
  addLog("info", "Auto-resolve timed out — trying to interact with challenge...");

  // Phase 2: Try clicking (up to 8 rounds)
  for (let attempt = 1; attempt <= 8; attempt++) {
    addLog("info", `Cloudflare interaction attempt ${attempt}/8...`);
    await simulateHumanMouse(page);

    // Try clicking turnstile iframe by bounding box
    let clicked = false;
    for (const ifrSel of CF_TURNSTILE_IFRAME_SELECTORS) {
      try {
        const ifrEl = await page.$(ifrSel);
        if (!ifrEl) continue;
        const box = await ifrEl.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          // Click the centre of the iframe (where the checkbox is)
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          await page.mouse.move(cx, cy, { steps: 8 });
          await sleep(200);
          await page.mouse.click(cx, cy);
          addLog("info", `Clicked turnstile iframe centre at (${Math.round(cx)}, ${Math.round(cy)})`);
          clicked = true;
          break;
        }
      } catch {}
    }

    if (!clicked) {
      clicked = await tryCfClickOnMainPage(page);
    }

    if (!clicked) {
      const frames = getAllFrames(page);
      for (const frame of frames) {
        try {
          const frameUrl: string = frame.url();
          if (isCfFrame(frameUrl)) {
            clicked = await tryCfClickInFrame(frame);
            if (clicked) {
              addLog("info", `Clicked inside CF frame: ${frameUrl}`);
              break;
            }
          }
        } catch {}
      }
    }

    if (!clicked) {
      addLog("warn", `Attempt ${attempt}: No clickable CF element found — waiting...`);
    }

    // Wait up to 8s checking every second
    for (let w = 0; w < 8; w++) {
      await sleep(1000);
      const still = await isCloudflareChallenge(page);
      if (!still) {
        addLog("success", `Cloudflare challenge passed on attempt ${attempt}`);
        await captureScreenshot();
        return true;
      }
    }
    await captureScreenshot();
  }

  addLog("error", "Cloudflare could not be bypassed. The Live Preview shows what the bot sees. Replit's IP may be flagged — try stopping and starting the bot again in a few minutes.");
  return false;
}

async function navigateTo(page: any, url: string, description: string): Promise<void> {
  addLog("info", `Navigating to ${description}: ${url}`);
  // Use networkidle2 so Cloudflare's JS challenge has time to run before we check
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 }).catch(async () => {
    // Fallback: domcontentloaded if networkidle2 times out (e.g. CF keeps connections open)
    addLog("info", "networkidle2 timed out — continuing with domcontentloaded fallback");
  });
  await captureScreenshot();

  const cfHandled = await handleCloudflareChallenge(page);
  if (!cfHandled) {
    throw new Error(`Cloudflare challenge on ${description} could not be bypassed — try stopping and starting the bot again in a few minutes`);
  }
}

async function tryFillField(page: any, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(value, { delay: 50 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function tryClick(page: any, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function captureScreenshot(): Promise<void> {
  if (!pageInstance) return;
  try {
    const raw = await pageInstance.screenshot({
      type: "jpeg",
      quality: 70,
      fullPage: false,
    });
    // puppeteer-extra may return a Uint8Array instead of a proper Buffer.
    // Always coerce to Buffer so .toString("base64") works correctly.
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    const base64 = buf.toString("base64");
    lastScreenshot = { data: base64, capturedAt: new Date().toISOString() };
    emitScreenshot(lastScreenshot.data!, lastScreenshot.capturedAt!);
  } catch (err) {
    logger.warn({ err }, "[bot] screenshot failed");
  }
}

async function doReload(): Promise<void> {
  if (!pageInstance) return;
  try {
    const targetUrl = process.env["TARGET_URL"] ?? "";
    addLog("info", `Reloading target page (reload #${reloadCount + 1})`);
    await pageInstance.reload({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });

    const cfHandled = await handleCloudflareChallenge(pageInstance);
    if (!cfHandled) {
      addLog("warn", "Cloudflare challenge appeared on reload — could not bypass, will retry next cycle");
      return;
    }

    lastReloadAt = new Date();
    reloadCount++;
    await captureScreenshot();
    emitStatus(getStatus());
    addLog("success", `Page reloaded successfully (#${reloadCount}) — ${targetUrl}`);
  } catch (err: any) {
    addLog("warn", `Reload failed: ${err?.message ?? String(err)}`);
  }
}

async function connectBrowser(): Promise<{ browser: any; page: any }> {
  const puppeteerExtra = await import("puppeteer-extra");
  const StealthPlugin = await import("puppeteer-extra-plugin-stealth");
  const puppeteer = await import("puppeteer");

  const pExtra = puppeteerExtra.default;
  pExtra.use(StealthPlugin.default());

  const chromeBinary = await findChromeBinary();

  const launchOptions: Record<string, any> = {
    headless: true,
    args: CHROME_LAUNCH_ARGS,
    ignoreHTTPSErrors: true,
    defaultViewport: { width: 1280, height: 720 },
  };

  if (chromeBinary) {
    addLog("info", `Using system Chrome: ${chromeBinary}`);
    launchOptions["executablePath"] = chromeBinary;
  } else {
    let bundledPath: string;
    try {
      bundledPath = puppeteer.default.executablePath();
    } catch {
      throw new Error(
        "No valid Chrome binary found and Puppeteer's bundled Chromium is not downloaded. " +
        "On your Ubuntu server run: pnpm install   (this downloads Chromium, ~170MB, once)"
      );
    }
    addLog("info", `No valid system Chrome found (snap stubs skipped) — using bundled Chromium: ${bundledPath}`);
    launchOptions["executablePath"] = bundledPath;
  }

  addLog("info", "Launching browser with stealth mode...");
  const browser = await pExtra.launch(launchOptions);
  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
  });

  addLog("success", "Browser launched successfully");
  return { browser, page };
}

export async function startBot(): Promise<BotStatus> {
  if (state === "active" || state === "logging_in" || state === "navigating") {
    addLog("warn", "Bot is already running");
    return getStatus();
  }

  const loginUrl = process.env["LOGIN_URL"] ?? "";
  const targetUrl = process.env["TARGET_URL"] ?? "";
  const username = process.env["BOT_USERNAME"] ?? "";
  const password = process.env["BOT_PASSWORD"] ?? "";

  if (!loginUrl || !targetUrl || !username || !password) {
    state = "error";
    errorMessage = "Missing required environment variables: LOGIN_URL, TARGET_URL, BOT_USERNAME, BOT_PASSWORD";
    addLog("error", errorMessage);
    return getStatus();
  }

  state = "logging_in";
  startedAt = new Date();
  reloadCount = 0;
  lastReloadAt = null;
  errorMessage = null;
  lastScreenshot = { data: null, capturedAt: null };
  addLog("info", "Launching browser...");
  emitStatus(getStatus());

  (async () => {
    try {
      const { browser, page } = await connectBrowser();
      browserInstance = browser;
      pageInstance = page;

      await pageInstance.setViewport({ width: 1280, height: 720 });

      // Start screenshot loop immediately so the user can watch the login & CF challenge live
      screenshotTimer = setInterval(captureScreenshot, 5_000);

      pageInstance.on("close", async () => {
        if (state === "active" || state === "navigating" || state === "logging_in") {
          addLog("warn", "Browser page closed unexpectedly — stopping bot");
          state = "error";
          errorMessage = "Browser page closed unexpectedly";
          emitStatus(getStatus());
          await cleanupBrowser();
        }
      });

      browserInstance.on("disconnected", async () => {
        if (state === "active" || state === "navigating" || state === "logging_in") {
          addLog("warn", "Browser disconnected — stopping bot");
          state = "error";
          errorMessage = "Browser disconnected";
          emitStatus(getStatus());
          await cleanupBrowser();
        }
      });

      await navigateTo(pageInstance, loginUrl, "login page");
      addLog("info", "Filling in login credentials...");

      const usernameFilled = await tryFillField(pageInstance, [
        'input[name="username"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[type="text"]',
        "#username", "#email", "#user",
        '[placeholder*="user" i]',
        '[placeholder*="email" i]',
      ], username);

      if (!usernameFilled) throw new Error("Could not find username/email input field on login page");

      const passwordFilled = await tryFillField(pageInstance, [
        'input[type="password"]',
        'input[name="password"]',
        "#password", "#pass",
        '[placeholder*="password" i]',
      ], password);

      if (!passwordFilled) throw new Error("Could not find password input field on login page");

      addLog("info", "Submitting login form...");

      const submitted = await tryClick(pageInstance, [
        'button[type="submit"]', 'input[type="submit"]',
        "button.login", ".btn-login", ".login-btn", ".login-button",
        '[data-testid="login-button"]', 'form button',
      ]);

      if (!submitted) await pageInstance.keyboard.press("Enter");

      await pageInstance.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS }).catch(() => {});

      await handleCloudflareChallenge(pageInstance);

      const currentUrl = pageInstance.url();
      addLog("success", `Login successful — redirected to: ${currentUrl}`);

      state = "navigating";
      emitStatus(getStatus());

      await navigateTo(pageInstance, targetUrl, "target page");

      state = "active";
      lastReloadAt = new Date();
      reloadCount++;
      await captureScreenshot();
      emitStatus(getStatus());
      addLog("success", `Now active on target page: ${targetUrl}`);

      // Upgrade screenshot interval to 10s now that bot is active
      if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
      reloadTimer = setInterval(doReload, RELOAD_INTERVAL_MS);
      screenshotTimer = setInterval(captureScreenshot, 10_000);
    } catch (err: any) {
      state = "error";
      errorMessage = err?.message ?? String(err);
      addLog("error", `Bot error: ${errorMessage}`);
      emitStatus(getStatus());
      await cleanupBrowser();
    }
  })();

  return getStatus();
}

async function cleanupBrowser(): Promise<void> {
  if (reloadTimer) { clearInterval(reloadTimer); reloadTimer = null; }
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  clearScreenshotCache();
  try {
    if (browserInstance) await browserInstance.close();
  } catch {} finally {
    browserInstance = null;
    pageInstance = null;
  }
}

export async function stopBot(): Promise<BotStatus> {
  if (state === "stopped" || state === "idle") {
    addLog("info", "Bot is already stopped");
    return getStatus();
  }
  addLog("info", "Stopping bot...");
  await cleanupBrowser();
  state = "stopped";
  errorMessage = null;
  addLog("success", "Bot stopped successfully");
  emitStatus(getStatus());
  return getStatus();
}

export function getStatus(): BotStatus {
  const now = new Date();
  const uptimeSeconds =
    startedAt && state !== "stopped" && state !== "idle"
      ? Math.floor((now.getTime() - startedAt.getTime()) / 1000)
      : 0;
  return {
    running: state === "active" || state === "logging_in" || state === "navigating",
    state,
    uptimeSeconds,
    startedAt: startedAt?.toISOString() ?? null,
    currentUrl: pageInstance ? (pageInstance.url?.() ?? null) : null,
    lastReloadAt: lastReloadAt?.toISOString() ?? null,
    reloadCount,
    errorMessage,
  };
}

export function getScreenshot(): BotScreenshot { return lastScreenshot; }
export function getLogs(): BotLogEntry[] { return auditLog; }
export function clearLogs(): void { auditLog.length = 0; }
