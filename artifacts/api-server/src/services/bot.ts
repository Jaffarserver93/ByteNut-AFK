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

const CHROME_ARGS = [
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

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findChromeBinary(): Promise<string | null> {
  const candidates = [
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
  ];
  for (const bin of candidates) {
    const p = await which(bin);
    if (p) return p;
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
    lastReloadAt = new Date();
    reloadCount++;
    await captureScreenshot();
    emitStatus(getStatus());
    addLog("success", `Page reloaded successfully (#${reloadCount}) — ${targetUrl}`);
  } catch (err: any) {
    addLog("warn", `Reload failed: ${err?.message ?? String(err)}`);
  }
}

async function connectBrowser(retries = 3): Promise<{ browser: any; page: any }> {
  const { connect } = await import("puppeteer-real-browser");
  const chromeBinary = await findChromeBinary();
  if (chromeBinary) {
    addLog("info", `Found Chrome binary: ${chromeBinary}`);
  } else {
    addLog("warn", "No Chrome binary found in PATH — puppeteer-real-browser will use its bundled browser");
  }

  const xvfbPath = await which("Xvfb");
  if (!xvfbPath) {
    addLog("warn", "Xvfb not found — Chrome may fail on a headless server. Install with: sudo apt-get install -y xvfb");
  } else {
    addLog("info", `Xvfb available at ${xvfbPath} — virtual display will be used`);
  }

  let lastErr: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt > 1) {
        addLog("info", `Browser connect attempt ${attempt}/${retries}...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      const result = await connect({
        headless: false,
        args: CHROME_ARGS,
        customConfig: chromeBinary ? { chromePath: chromeBinary } : {},
        turnstile: true,
        connectOption: { defaultViewport: null },
        disableXvfb: false,
        ignoreAllFlags: false,
      });
      return { browser: result.browser, page: result.page };
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message ?? String(err);
      logger.warn({ err, attempt }, "[bot] connect attempt %d failed: %s", attempt, msg);
      if (attempt < retries) {
        addLog("warn", `Browser launch attempt ${attempt} failed (${msg}) — retrying...`);
      }
    }
  }
  throw lastErr;
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
      const { browser, page } = await connectBrowser(3);
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

      addLog("info", `Navigating to login page: ${loginUrl}`);
      emitStatus(getStatus());

      await pageInstance.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
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

      const currentUrl = pageInstance.url();
      addLog("success", `Login successful — redirected to: ${currentUrl}`);

      state = "navigating";
      emitStatus(getStatus());
      addLog("info", `Navigating to target page: ${targetUrl}`);

      await pageInstance.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });

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
