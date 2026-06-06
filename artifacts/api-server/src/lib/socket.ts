import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { logger } from "./logger.js";

let io: SocketIOServer | null = null;

let lastScreenshotPayload: { data: string; capturedAt: string } | null = null;
let lastStatusPayload: object | null = null;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/socket.io",
    maxHttpBufferSize: 5 * 1024 * 1024,
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "[socket] client connected");

    if (lastScreenshotPayload) {
      socket.emit("screenshot", lastScreenshotPayload);
    }
    if (lastStatusPayload) {
      socket.emit("status", lastStatusPayload);
    }

    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id }, "[socket] client disconnected");
    });
  });

  return io;
}

export function emitScreenshot(data: string, capturedAt: string): void {
  lastScreenshotPayload = { data, capturedAt };
  io?.emit("screenshot", lastScreenshotPayload);
}

export function emitStatus(status: object): void {
  lastStatusPayload = status;
  io?.emit("status", status);
}

export function emitLog(entry: object): void {
  io?.emit("log", entry);
}

export function clearScreenshotCache(): void {
  lastScreenshotPayload = null;
}
