import { io, Socket } from "socket.io-client";

const socket: Socket = io({
  path: "/socket.io",
  transports: ["websocket", "polling"],
  autoConnect: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

export default socket;
