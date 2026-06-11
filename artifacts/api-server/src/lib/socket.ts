import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { logger } from "./logger.js";

let wss: WebSocketServer | null = null;

let lastScreenshotPayload: { data: string; capturedAt: string } | null = null;
let lastStatusPayload: object | null = null;

function broadcast(clients: Set<WebSocket>, message: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function initSocket(httpServer: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    logger.info("[ws] client connected");

    if (lastScreenshotPayload) {
      ws.send(JSON.stringify({ type: "screenshot", ...lastScreenshotPayload }));
    }
    if (lastStatusPayload) {
      ws.send(JSON.stringify({ type: "status", ...lastStatusPayload }));
    }

    ws.on("close", () => {
      logger.info("[ws] client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err }, "[ws] client error");
    });
  });

  return wss;
}

export function emitScreenshot(data: string, capturedAt: string): void {
  lastScreenshotPayload = { data, capturedAt };
  if (!wss) return;
  broadcast(wss.clients, JSON.stringify({ type: "screenshot", data, capturedAt }));
}

export function emitStatus(status: object): void {
  lastStatusPayload = status;
  if (!wss) return;
  broadcast(wss.clients, JSON.stringify({ type: "status", ...status }));
}

export function emitLog(entry: object): void {
  if (!wss) return;
  broadcast(wss.clients, JSON.stringify({ type: "log", ...entry }));
}

export function clearScreenshotCache(): void {
  lastScreenshotPayload = null;
}
