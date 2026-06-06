import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { logger } from "./logger.js";

let io: SocketIOServer | null = null;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/socket.io",
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "[socket] client connected");
    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id }, "[socket] client disconnected");
    });
  });

  return io;
}

export function emitScreenshot(data: string, capturedAt: string): void {
  io?.emit("screenshot", { data, capturedAt });
}

export function emitStatus(status: object): void {
  io?.emit("status", status);
}

export function emitLog(entry: object): void {
  io?.emit("log", entry);
}
