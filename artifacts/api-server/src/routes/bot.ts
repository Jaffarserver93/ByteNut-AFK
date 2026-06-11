import { Router, type IRouter } from "express";
import {
  startBot,
  stopBot,
  getStatus,
  getScreenshot,
  getLogs,
  clearLogs,
  diagnose,
  testGmailConnection,
} from "../services/bot.js";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res) => {
  res.json(getStatus());
});

router.post("/bot/start", async (_req, res) => {
  res.json(await startBot());
});

router.post("/bot/stop", async (_req, res) => {
  res.json(await stopBot());
});

router.get("/bot/screenshot", async (_req, res) => {
  res.json(getScreenshot());
});

router.get("/bot/logs", async (_req, res) => {
  res.json(getLogs());
});

router.delete("/bot/logs", async (_req, res) => {
  clearLogs();
  res.json({ success: true });
});

router.get("/bot/diagnose", async (_req, res) => {
  res.json(await diagnose());
});

router.get("/bot/test-gmail", async (_req, res) => {
  res.json(await testGmailConnection());
});

export default router;
