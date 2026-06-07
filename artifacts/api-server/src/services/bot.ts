import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
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
  timeRemainingMinutes: number | null;
  lastRenewAt: string | null;
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
const RELOAD_TIMEOUT_MS = 60_000;

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
    // Prefer NixOS system chromium — confirmed working in this environment
    "/run/current-system/sw/bin/chromium",
    "chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Google Chrome fallbacks (may not be present or may be snap stubs)
    "google-chrome-stable",
    "google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
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
let xvfbProcess: ChildProcess | null = null;
let state: BotState = "stopped";
let startedAt: Date | null = null;
let lastReloadAt: Date | null = null;
let lastRenewAt: Date | null = null;
let reloadCount = 0;
let errorMessage: string | null = null;
let timeRemainingMinutes: number | null = null;
let timeReadAt: Date | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let lastScreenshot: BotScreenshot = { data: null, capturedAt: null };
let isRenewing = false;
const auditLog: BotLogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function setTimeRemaining(minutes: number): void {
  timeRemainingMinutes = minutes;
  timeReadAt = new Date();
}

const XVFB_DISPLAY = ":99";

async function ensureVirtualDisplay(): Promise<void> {
  // Kill any stale Xvfb on our display slot
  try { await execFileAsync("pkill", ["-f", `Xvfb ${XVFB_DISPLAY}`], { timeout: 3000 }); } catch {}
  await sleep(400);

  await new Promise<void>((resolve) => {
    xvfbProcess = spawn(
      "Xvfb",
      [XVFB_DISPLAY, "-screen", "0", "1280x720x24", "-ac", "+extension", "RANDR"],
      { detached: true, stdio: "ignore" },
    );
    xvfbProcess.unref();

    xvfbProcess.on("error", (err) => {
      logger.warn({ err }, "[bot] Xvfb failed to start — continuing without virtual display");
      resolve();
    });

    // Give Xvfb ~1.5s to initialise before Chrome tries to use it
    setTimeout(() => {
      process.env["DISPLAY"] = XVFB_DISPLAY;
      addLog("info", `Virtual display started on ${XVFB_DISPLAY}`);
      resolve();
    }, 1500);
  });
}

function stopXvfb(): void {
  if (xvfbProcess) {
    try { xvfbProcess.kill("SIGTERM"); } catch {}
    xvfbProcess = null;
  }
}

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
    // NOTE: We intentionally do NOT check for iframe URLs here.
    // An embedded Turnstile widget (e.g. "Verify you are human" checkbox inside a
    // page that has otherwise loaded) also uses challenges.cloudflare.com iframes,
    // but is NOT a full-page challenge. Treating it as one sends the bot into the
    // wrong bypass flow where it finds nothing to click.
    // Embedded Turnstile widgets are handled by handleEmbeddedTurnstile() instead.
  } catch {}
  return false;
}

/**
 * Detects and clicks an embedded Cloudflare Turnstile checkbox widget that lives
 * inside a page that has already loaded (e.g. the ByteNut "Extend Server Time" form).
 * Returns true if the widget was found and clicked (or was already solved), false otherwise.
 */
async function handleEmbeddedTurnstile(page: any): Promise<boolean> {
  const turnstileIframeSelectors = [
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='cloudflare.com/cdn-cgi/challenge-platform']",
    "iframe[src*='cloudflare.com/cdn-cgi/turnstile']",
    "iframe[title*='cloudflare' i]",
    "iframe[title*='turnstile' i]",
  ];

  for (const ifrSel of turnstileIframeSelectors) {
    try {
      const ifrEl = await page.$(ifrSel);
      if (!ifrEl) continue;

      // Check if already solved (hidden input has a non-empty value)
      try {
        const responseInput = await page.$('input[name="cf-turnstile-response"]');
        if (responseInput) {
          const val: string = await page.evaluate((el: any) => el.value, responseInput);
          if (val && val.length > 10) {
            addLog("info", "Embedded Turnstile already solved (response value present)");
            return true;
          }
        }
      } catch {}

      const box = await ifrEl.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;

      addLog("info", `Found embedded Turnstile iframe (${Math.round(box.width)}×${Math.round(box.height)}) — attempting to click checkbox...`);

      // Strategy 1: Access the iframe's contentFrame and click checkbox inside it
      try {
        const frame = await ifrEl.contentFrame();
        if (frame) {
          await simulateHumanMouse(page);
          await sleep(500);

          const checkboxSelectors = [
            "input[type='checkbox']",
            ".ctp-checkbox-label",
            ".cb-lb",
            ".mark",
            "[id^='cf-chl-widget']",
            "label",
            "div[role='checkbox']",
          ];

          for (const cbSel of checkboxSelectors) {
            try {
              const cbEl = await frame.$(cbSel);
              if (!cbEl) continue;
              const cbBox = await cbEl.boundingBox();
              if (cbBox && cbBox.width > 0 && cbBox.height > 0) {
                await frame.mouse
                  ? frame.mouse.move(cbBox.x + cbBox.width / 2, cbBox.y + cbBox.height / 2, { steps: 5 })
                  : null;
                await sleep(200);
                await cbEl.click();
                addLog("info", `Clicked Turnstile checkbox via contentFrame (selector: ${cbSel})`);
                await sleep(2000);
                return true;
              }
            } catch {}
          }
        }
      } catch {}

      // Strategy 2: Click the centre of the iframe bounding box directly on the page
      try {
        await simulateHumanMouse(page);
        await sleep(300);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;

        // Move in and click the left part (where checkbox is, not the logo)
        const checkboxCx = box.x + Math.min(30, box.width * 0.25);
        const checkboxCy = box.y + box.height / 2;

        await page.mouse.move(checkboxCx, checkboxCy, { steps: 8 });
        await sleep(200);
        await page.mouse.click(checkboxCx, checkboxCy);
        addLog("info", `Clicked Turnstile iframe at checkbox position (${Math.round(checkboxCx)}, ${Math.round(checkboxCy)})`);
        await sleep(2000);
        return true;
      } catch {}

      // Strategy 3: Click dead-centre of the iframe as last resort
      try {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.click(cx, cy);
        addLog("info", `Clicked Turnstile iframe centre (${Math.round(cx)}, ${Math.round(cy)})`);
        await sleep(2000);
        return true;
      } catch {}
    } catch {}
  }
  return false;
}

/**
 * Polls the hidden Turnstile response input until it has a value (meaning
 * puppeteer-real-browser auto-solved it), or until timeoutMs is exceeded.
 */
async function waitForTurnstileAutoSolved(page: any, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const val: string = await page.evaluate(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return input?.value ?? "";
      });
      if (val && val.length > 10) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

/**
 * After reaching the target page, interact with the page-specific actions:
 * wait for Turnstile to be auto-solved (puppeteer-real-browser handles this),
 * then click "Extend Server Time" if present.
 */
async function handleTargetPageActions(page: any): Promise<void> {
  // ── Step 1: Handle Turnstile ──────────────────────────────────────────────
  try {
    const turnstileInput = await page.$('input[name="cf-turnstile-response"]');
    if (turnstileInput) {
      // First check if it's already solved
      const currentVal: string = await page.evaluate((el: any) => el.value ?? "", turnstileInput);
      if (currentVal && currentVal.length > 10) {
        addLog("info", "Embedded Turnstile already solved — proceeding");
      } else {
        addLog("info", "Embedded Turnstile detected — waiting for puppeteer-real-browser to auto-solve (up to 20s)...");
        await captureScreenshot();
        const solved = await waitForTurnstileAutoSolved(page, 20_000);
        if (!solved) {
          addLog("warn", "Turnstile not auto-solved after 20s — skipping Extend button this cycle");
          return; // Do NOT click Extend if Turnstile isn't solved
        }
        addLog("success", "Turnstile auto-solved — proceeding to click Extend button");
        await captureScreenshot();
      }
    }
  } catch {}

  // ── Step 2: Click the Extend / Renew button ───────────────────────────────
  // Only match actual interactive elements (button, a), check innerText directly
  // to avoid matching parent container text.
  try {
    const candidates = await page.$$("button, a[href], input[type='button'], input[type='submit']");
    for (const el of candidates) {
      try {
        const box = await el.boundingBox();
        if (!box || box.width < 10 || box.height < 10) continue;

        // Use innerText so we get only what's visible, not child-element noise
        const text: string = await page.evaluate((e: any) => (e.innerText ?? e.value ?? "").trim(), el);
        const lower = text.toLowerCase();

        if (
          lower.includes("extend server") ||
          lower.includes("+180") ||
          lower.includes("extend time") ||
          (lower.includes("extend") && lower.length < 60)
        ) {
          addLog("info", `Clicking: "${text.slice(0, 80)}"`);
          await el.click();
          await sleep(2000);
          await captureScreenshot();
          addLog("success", "Extend Server Time clicked successfully");
          return;
        }
      } catch {}
    }
  } catch {}
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

// ─── Time Remaining Helpers ───────────────────────────────────────────────────

function parseTimeToMinutes(text: string): number | null {
  const hMatch = text.match(/(\d+)\s*h/i);
  const mMatch = text.match(/(\d+)\s*m/i);
  if (!hMatch && !mMatch) return null;
  const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
  const mins  = mMatch ? parseInt(mMatch[1], 10) : 0;
  return hours * 60 + mins;
}

async function extractTimeRemainingMinutes(page: any): Promise<number | null> {
  try {
    // Primary: read from .clock-time span (e.g. "02:56" meaning 2h 56m)
    const clockText: string | null = await page.evaluate(() => {
      const el = document.querySelector(".clock-time");
      return el ? (el as HTMLElement).innerText.trim() : null;
    });

    if (clockText) {
      // Format "HH:MM" — convert to total minutes
      const parts = clockText.split(":").map((p) => parseInt(p, 10));
      if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
        return parts[0] * 60 + parts[1];
      }
      // Format "H h M m" or plain minutes
      const parsed = parseTimeToMinutes(clockText);
      if (parsed !== null) return parsed;
    }

    // Fallback: scan for "FREE TIME LEFT" text
    const rawText: string = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent?.toLowerCase().includes("free time left")) {
          return (node.parentElement?.closest("[class]") as HTMLElement | null)?.innerText
            ?? node.parentElement?.innerText
            ?? "";
        }
      }
      return (document.body as HTMLElement).innerText ?? "";
    });

    const match = rawText.match(/free\s+time\s+left[:\s\n]+([0-9]+\s*h\s*[0-9]*\s*m?|[0-9]+\s*m)/i);
    if (match) return parseTimeToMinutes(match[1]);

    const fallback = rawText.match(/([0-9]+\s*h\s*[0-9]+\s*m|[0-9]+\s*h|[0-9]+\s*m)\s*(remaining|left)/i);
    if (fallback) return parseTimeToMinutes(fallback[1]);

    return null;
  } catch {
    return null;
  }
}

// ─── Login Helper ─────────────────────────────────────────────────────────────

async function doLogin(page: any): Promise<void> {
  const loginUrl = process.env["LOGIN_URL"] ?? "";
  const username = process.env["BOT_USERNAME"] ?? "";
  const password = process.env["BOT_PASSWORD"] ?? "";

  await navigateTo(page, loginUrl, "login page");
  addLog("info", "Filling in login credentials...");

  const usernameFilled = await tryFillField(page, [
    'input[name="username"]', 'input[name="email"]',
    'input[type="email"]', 'input[type="text"]',
    "#username", "#email", "#user",
    '[placeholder*="user" i]', '[placeholder*="email" i]',
  ], username);

  if (!usernameFilled) throw new Error("Could not find username/email input field on login page");

  const passwordFilled = await tryFillField(page, [
    'input[type="password"]', 'input[name="password"]',
    "#password", "#pass", '[placeholder*="password" i]',
  ], password);

  if (!passwordFilled) throw new Error("Could not find password input field on login page");

  addLog("info", "Submitting login form...");

  const submitted = await tryClick(page, [
    'button[type="submit"]', 'input[type="submit"]',
    "button.login", ".btn-login", ".login-btn", ".login-button",
    '[data-testid="login-button"]', 'form button',
  ]);

  if (!submitted) await page.keyboard.press("Enter");

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  await handleCloudflareChallenge(page);

  const currentUrl = page.url();
  addLog("success", `Login successful — redirected to: ${currentUrl}`);
}

// ─── Page Monitor ─────────────────────────────────────────────────────────────

async function ensureOnTargetPage(page: any): Promise<void> {
  const targetUrl = process.env["TARGET_URL"] ?? "";
  let currentUrl = "";
  try { currentUrl = page.url(); } catch {}

  const targetBase = targetUrl.split("?")[0];
  if (currentUrl && (currentUrl === targetUrl || currentUrl.startsWith(targetBase))) return;

  addLog("warn", `Bot drifted off target (now at: ${currentUrl}) — redirecting...`);
  await captureScreenshot();

  // Re-login if session expired
  if (currentUrl.includes("/auth/login") || currentUrl.includes("/login")) {
    addLog("info", "Session expired — re-logging in...");
    state = "logging_in";
    emitStatus(getStatus());
    await doLogin(page);
    state = "navigating";
    emitStatus(getStatus());
  }

  await navigateTo(page, targetUrl, "target page");
  state = "active";
  emitStatus(getStatus());
  addLog("success", "Returned to target page");
}

// ─── Auto-Renew Flow ──────────────────────────────────────────────────────────

async function clickRenewSidebarButton(page: any): Promise<boolean> {
  // Wait up to 5s for sidebar to be present after page navigation
  const cssSelectors = [
    ".renew-server-menu-item",
    "li.renew-server-menu-item",
    'li[class*="renew"]',
    'a[href*="renew"]',
    '[data-action*="renew" i]',
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    // CSS selectors (fastest)
    for (const sel of cssSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
            await sleep(150);
            await el.click();
            return true;
          }
        }
      } catch {}
    }

    // Text-based fallback — broader tag set, case-insensitive
    try {
      const clicked: boolean = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("li, button, a, span, div[role='button']"));
        for (const el of items) {
          const txt = ((el as HTMLElement).innerText ?? (el as HTMLElement).textContent ?? "").trim().toUpperCase();
          if (txt.includes("RENEW SERVER") || txt === "RENEW") {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) return true;
    } catch {}

    if (attempt < 2) {
      await sleep(1500); // Wait for sidebar to render before retrying
    }
  }
  return false;
}

async function readClockTimeFromPage(page: any): Promise<string | null> {
  try {
    const text: string | null = await page.evaluate(() => {
      const el = document.querySelector(".clock-time");
      return el ? (el as HTMLElement).innerText.trim() : null;
    });
    return text ?? null;
  } catch {
    return null;
  }
}

async function doRenewFlow(page: any): Promise<void> {
  isRenewing = true;
  // ── Step 1: Click RENEW SERVER sidebar button ─────────────────────────────
  addLog("info", "Clicking left sidebar RENEW SERVER...");
  await captureScreenshot();

  const renewClicked = await clickRenewSidebarButton(page);
  if (!renewClicked) {
    addLog("warn", "Could not find RENEW SERVER sidebar button — skipping this cycle");
    isRenewing = false;
    return;
  }

  addLog("info", "Clicked left sidebar RENEW SERVER — waiting for modal to load...");
  await sleep(2500);
  await captureScreenshot();

  // ── Step 2: Read time remaining from the modal page ───────────────────────
  const clockText = await readClockTimeFromPage(page);
  let modalMinutes: number | null = null;

  if (clockText) {
    const parts = clockText.split(":").map((p) => parseInt(p, 10));
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      modalMinutes = parts[0] * 60 + parts[1];
    } else {
      modalMinutes = parseTimeToMinutes(clockText);
    }
    addLog("info", `Time remaining (modal): ${clockText}`);
    if (modalMinutes !== null) {
      setTimeRemaining(modalMinutes);
      emitStatus(getStatus());
    }
  } else {
    addLog("info", "Could not read time remaining from modal");
  }

  // ── Step 3: Only extend if time is under 60 min ───────────────────────────
  if (modalMinutes === null || modalMinutes >= 60) {
    if (modalMinutes !== null) {
      const h = Math.floor(modalMinutes / 60);
      const m = modalMinutes % 60;
      addLog("info", `Server time: ${h}h ${m}m remaining — auto-renew triggers at < 60min`);
    }
    // Release the lock BEFORE the back-navigation so a slow/CF-challenged
    // navigation cannot block the next reload cycle.
    isRenewing = false;
    const targetUrl = process.env["TARGET_URL"] ?? "";
    navigateTo(page, targetUrl, "target page (back from renew modal)").catch(() => {});
    return;
  }

  addLog("warn", `⚠️ Only ${modalMinutes}m remaining — solving Turnstile & extending...`);

  // ── Step 4: Solve Turnstile with active retry loop ────────────────────────
  // Give the renewal page a moment to fully render the Turnstile widget
  await sleep(3000);
  await captureScreenshot();

  // First check whether a Turnstile even exists on this page
  const hasTurnstileInput = await page.$('input[name="cf-turnstile-response"]').catch(() => null);
  if (!hasTurnstileInput) {
    // No Turnstile present — jump straight to clicking Extend
    addLog("info", "No Turnstile detected on renew page — proceeding to Extend button directly");
  } else {
    let solved = false;
    const MAX_TURNSTILE_ATTEMPTS = 4;

    for (let attempt = 1; attempt <= MAX_TURNSTILE_ATTEMPTS && !solved; attempt++) {
      addLog("info", `Turnstile solve attempt ${attempt}/${MAX_TURNSTILE_ATTEMPTS}...`);
      await captureScreenshot();

      // Phase A: Check if already solved (token present from a previous round)
      const existingVal: string = await page.evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return el?.value ?? "";
      }).catch(() => "");
      if (existingVal && existingVal.length > 10) {
        addLog("success", "Turnstile already has a valid token — proceeding");
        solved = true;
        break;
      }

      // Phase B: Wait up to 12s for puppeteer-real-browser to auto-solve
      solved = await waitForTurnstileAutoSolved(page, 12_000);
      if (solved) break;

      // Phase C: Auto-solve failed — actively click the widget to reset/trigger it
      addLog("info", `Auto-solve timed out on attempt ${attempt} — clicking Turnstile widget to reset it...`);
      await handleEmbeddedTurnstile(page);
      await sleep(1500);

      // Phase D: Wait again after the manual click
      solved = await waitForTurnstileAutoSolved(page, 10_000);
      if (solved) break;

      // Phase E: Try resetting the widget via JS (forces a fresh challenge)
      try {
        await page.evaluate(() => {
          if (typeof (window as any).turnstile?.reset === "function") {
            (window as any).turnstile.reset();
          } else {
            // Try resetting each widget by iterating sitekeys
            const containers = document.querySelectorAll("[data-sitekey], .cf-turnstile");
            containers.forEach((c: any) => {
              try { (window as any).turnstile?.reset(c); } catch {}
            });
          }
        });
        addLog("info", "Triggered turnstile.reset() — waiting for fresh challenge...");
      } catch {}
      await sleep(3000);
      await captureScreenshot();
    }

    if (!solved) {
      addLog("warn", `Turnstile could not be solved after ${MAX_TURNSTILE_ATTEMPTS} attempts — will retry on next cycle`);
      isRenewing = false;
      return;
    }
  }

  addLog("success", "Turnstile solved — clicking Extend button...");
  await captureScreenshot();
  await sleep(500);

  // ── Step 5: Click the Extend button ──────────────────────────────────────
  const candidates = await page.$$("button, a[href], input[type='button'], input[type='submit']");
  for (const el of candidates) {
    try {
      const box = await el.boundingBox();
      if (!box || box.width < 10 || box.height < 10) continue;
      const text: string = await page.evaluate((e: any) => (e.innerText ?? e.value ?? "").trim(), el);
      const lower = text.toLowerCase();
      if (
        lower.includes("extend server") ||
        lower.includes("+180") ||
        lower.includes("extend time") ||
        (lower.includes("extend") && lower.length < 60)
      ) {
        addLog("info", `Clicking: "${text.slice(0, 80)}"`);
        await el.click();
        await sleep(2500);
        await captureScreenshot();
        lastRenewAt = new Date();
        addLog("success", "✅ Server time extended successfully! (+180 min)");
        emitStatus(getStatus());
        isRenewing = false;
        return;
      }
    } catch {}
  }

  addLog("warn", "Extend button not found after Turnstile solved — skipping");
  isRenewing = false;
}

// ─── Main Reload Cycle ────────────────────────────────────────────────────────

async function doReload(): Promise<void> {
  if (!pageInstance) return;
  if (isRenewing) {
    addLog("info", "Skipping reload cycle — renewal in progress");
    return;
  }
  try {
    const targetUrl = process.env["TARGET_URL"] ?? "";

    // Step 1: Ensure we're still on the target page (handles drift + session expiry)
    await ensureOnTargetPage(pageInstance);

    // Step 2: Reload to refresh content
    addLog("info", `Refreshing target page (cycle #${reloadCount + 1})`);
    await pageInstance.reload({ waitUntil: "domcontentloaded", timeout: RELOAD_TIMEOUT_MS }).catch((err: any) => {
      addLog("info", `Page reload timed out (${err?.message?.slice(0, 60) ?? "timeout"}) — continuing anyway`);
    });

    const cfHandled = await handleCloudflareChallenge(pageInstance);
    if (!cfHandled) {
      addLog("warn", "Cloudflare appeared on reload — will retry next cycle");
      return;
    }

    await sleep(1500); // Let Vue/React page hydrate
    await captureScreenshot();

    // Step 3: Read time remaining from the page
    const minutes = await extractTimeRemainingMinutes(pageInstance);
    if (minutes !== null) {
      setTimeRemaining(minutes);
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      addLog("info", `Server time remaining: ${h > 0 ? `${h}h ` : ""}${m}m`);
    } else if (timeRemainingMinutes !== null && timeReadAt !== null) {
      // Estimate from last known value by subtracting elapsed minutes
      const elapsedMins = Math.floor((Date.now() - timeReadAt.getTime()) / 60_000);
      const estimated = Math.max(0, timeRemainingMinutes - elapsedMins);
      const h = Math.floor(estimated / 60);
      const m = estimated % 60;
      addLog("info", `Server time remaining (estimated): ${h > 0 ? `${h}h ` : ""}${m}m`);
    } else {
      addLog("info", "Could not read server time remaining from page");
    }

    lastReloadAt = new Date();
    reloadCount++;
    emitStatus(getStatus());
    addLog("success", `Cycle #${reloadCount} complete — ${targetUrl}`);

    // Step 4: Only visit the renew modal when time is actually low (≤ 70 min) or unknown.
    // If the target page already told us there's plenty of time, skip the round-trip entirely.
    const effectiveMinutes = minutes !== null
      ? minutes
      : (timeRemainingMinutes !== null && timeReadAt !== null
          ? Math.max(0, timeRemainingMinutes - Math.floor((Date.now() - timeReadAt.getTime()) / 60_000))
          : null);

    if (effectiveMinutes === null || effectiveMinutes <= 30) {
      await doRenewFlow(pageInstance);
    } else {
      const h = Math.floor(effectiveMinutes / 60);
      const m = effectiveMinutes % 60;
      addLog("info", `Server time: ${h}h ${m}m remaining — renew check skipped (triggers ≤ 30min)`);
    }

    await captureScreenshot();
    emitStatus(getStatus());
  } catch (err: any) {
    addLog("warn", `Cycle failed: ${err?.message ?? String(err)}`);
  }
}

async function connectBrowser(): Promise<{ browser: any; page: any }> {
  await ensureVirtualDisplay();

  const chromeBinary = await findChromeBinary();

  const connectOptions: Record<string, any> = {
    // puppeteer-real-browser uses Xvfb automatically on headless Linux servers
    headless: false,
    args: CHROME_LAUNCH_ARGS,
    // Auto-solve embedded Cloudflare Turnstile widgets
    turnstile: true,
    // Don't randomise fingerprint — it can break Turnstile's bot-detection
    fingerprint: false,
    connectOption: {
      defaultViewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    },
    skipTarget: [],
  };

  if (chromeBinary) {
    addLog("info", `Using system Chrome: ${chromeBinary}`);
    connectOptions["customConfig"] = { executablePath: chromeBinary };
  } else {
    // Fallback: let puppeteer-real-browser find Chrome itself
    addLog("info", "No system Chrome found — letting puppeteer-real-browser locate Chrome");
  }

  addLog("info", "Launching browser with puppeteer-real-browser (turnstile: true)...");

  const { connect } = await import("puppeteer-real-browser");
  const { browser, page } = await connect(connectOptions);

  // Ensure viewport is set (connectOption.defaultViewport may be ignored in some versions)
  try { await page.setViewport({ width: 1280, height: 720 }); } catch {}

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
  lastRenewAt = null;
  timeRemainingMinutes = null;
  timeReadAt = null;
  errorMessage = null;
  lastScreenshot = { data: null, capturedAt: null };
  isRenewing = false;
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
          addLog("warn", "Browser page closed unexpectedly — restarting in 15s...");
          state = "error";
          errorMessage = "Browser page closed unexpectedly — restarting...";
          emitStatus(getStatus());
          await cleanupBrowser();
          setTimeout(() => startBot(), 15_000);
        }
      });

      browserInstance.on("disconnected", async () => {
        if (state === "active" || state === "navigating" || state === "logging_in") {
          addLog("warn", "Browser disconnected — restarting in 15s...");
          state = "error";
          errorMessage = "Browser disconnected — restarting...";
          emitStatus(getStatus());
          await cleanupBrowser();
          setTimeout(() => startBot(), 15_000);
        }
      });

      // Login
      await doLogin(pageInstance);

      state = "navigating";
      emitStatus(getStatus());

      await navigateTo(pageInstance, targetUrl, "target page");

      state = "active";
      lastReloadAt = new Date();
      reloadCount++;
      await captureScreenshot();
      emitStatus(getStatus());
      addLog("success", `Now active on target page: ${targetUrl}`);

      // Read initial time remaining
      await sleep(1500);
      const initMinutes = await extractTimeRemainingMinutes(pageInstance);
      if (initMinutes !== null) {
        setTimeRemaining(initMinutes);
        const h = Math.floor(initMinutes / 60);
        const m = initMinutes % 60;
        addLog("info", `Server time remaining: ${h > 0 ? `${h}h ` : ""}${m}m`);
        emitStatus(getStatus());
        if (initMinutes < 20) {
          addLog("warn", `⚠️ Only ${initMinutes}m remaining — triggering auto-renew immediately!`);
          await doRenewFlow(pageInstance);
        }
      }

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
  stopXvfb();
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
    timeRemainingMinutes: (() => {
      if (timeRemainingMinutes === null || timeReadAt === null) return timeRemainingMinutes;
      const elapsedMins = Math.floor((Date.now() - timeReadAt.getTime()) / 60_000);
      return Math.max(0, timeRemainingMinutes - elapsedMins);
    })(),
    lastRenewAt: lastRenewAt?.toISOString() ?? null,
  };
}

export function getScreenshot(): BotScreenshot { return lastScreenshot; }
export function getLogs(): BotLogEntry[] { return auditLog; }
export function clearLogs(): void { auditLog.length = 0; }
