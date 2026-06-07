import "dotenv/config";
import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { initSocket } from "./lib/socket";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error({ reason: msg }, "[process] Unhandled promise rejection — caught to keep server alive");
});

process.on("uncaughtException", (err: Error) => {
  logger.error({ err }, "[process] Uncaught exception — caught to keep server alive");
});

const httpServer = createServer(app);
initSocket(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});
