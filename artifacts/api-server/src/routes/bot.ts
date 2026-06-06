import { Router, type IRouter } from "express";
import {
  startBot,
  stopBot,
  getStatus,
  getScreenshot,
  getLogs,
  clearLogs,
} from "../services/bot.js";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res) => {
  const status = getStatus();
  res.json(status);
});

router.post("/bot/start", async (_req, res) => {
  const status = await startBot();
  res.json(status);
});

router.post("/bot/stop", async (_req, res) => {
  const status = await stopBot();
  res.json(status);
});

router.get("/bot/screenshot", async (_req, res) => {
  const screenshot = getScreenshot();
  res.json(screenshot);
});

router.get("/bot/logs", async (_req, res) => {
  const logs = getLogs();
  res.json(logs);
});

router.delete("/bot/logs", async (_req, res) => {
  clearLogs();
  res.json({ success: true });
});

export default router;
