import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../lib/logger.js";
import { emitScreenshot, emitStatus, emitLog } from "../lib/socket.js";

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
  "--window-size=1280,800",
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
    "/snap/bin/chromium",
    "chromium",
    "/usr/bin/chromium",
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

async function clickCloudflareCheckbox(page: any): Promise<boolean> {
  const frames: any[] = page.frames();

  for (const frame of frames) {
    const frameUrl: string = frame.url();
    if (
      frameUrl.includes("challenges.cloudflare.com") ||
      frameUrl.includes("cloudflare.com/cdn-cgi/challenge-platform")
    ) {
      for (const sel of CF_CHECKBOX_SELECTORS) {
        try {
          const el = await frame.$(sel);
          if (el) {
            const box = await el.boundingBox();
            if (box) {
              await el.click();
              return true;
            }
          }
        } catch {}
      }

      try {
        const body = await frame.$("body");
        if (body) {
          const box = await body.boundingBox();
          if (box) {
            await frame.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            return true;
          }
        }
      } catch {}
    }
  }

  for (const sel of CF_TURNSTILE_IFRAME_SELECTORS) {
    try {
      const iframeEl = await page.$(sel);
      if (iframeEl) {
        const box = await iframeEl.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
      }
    } catch {}
  }

  return false;
}

async function handleCloudflareChallenge(page: any, maxAttempts = 5): Promise<boolean> {
  const onChallenge = await isCloudflareChallenge(page);
  if (!onChallenge) return true;

  addLog("warn", "Cloudflare challenge detected — attempting to solve...");
  await captureScreenshot();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    addLog("info", `Cloudflare solve attempt ${attempt}/${maxAttempts} — clicking checkbox...`);

    await sleep(1500 + Math.random() * 1000);

    const clicked = await clickCloudflareCheckbox(page);
    if (clicked) {
      addLog("info", "Checkbox clicked — waiting for verification...");
    } else {
      addLog("warn", `Attempt ${attempt}: Could not find Cloudflare checkbox`);
    }

    await sleep(4000 + Math.random() * 2000);

    const stillOnChallenge = await isCloudflareChallenge(page);
    if (!stillOnChallenge) {
      addLog("success", `Cloudflare challenge passed on attempt ${attempt}`);
      await captureScreenshot();
      return true;
    }

    if (attempt < maxAttempts) {
      await sleep(3000 * attempt);
    }
  }

  addLog("error", "Cloudflare challenge could not be solved after all attempts");
  await captureScreenshot();
  return false;
}

async function navigateTo(page: any, url: string, description: string): Promise<void> {
  addLog("info", `Navigating to ${description}: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });

  const cfHandled = await handleCloudflareChallenge(page);
  if (!cfHandled) {
    throw new Error(`Cloudflare challenge on ${description} could not be bypassed — try again later or check if the server IP is flagged`);
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
    const buf: Buffer = await pageInstance.screenshot({ type: "png", fullPage: false });
    lastScreenshot = { data: buf.toString("base64"), capturedAt: new Date().toISOString() };
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
    defaultViewport: { width: 1280, height: 800 },
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

      await pageInstance.setViewport({ width: 1280, height: 800 });

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

      reloadTimer = setInterval(doReload, RELOAD_INTERVAL_MS);
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
