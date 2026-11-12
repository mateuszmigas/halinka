import { createWebSocketStream, type WebSocket } from "ws";

// A stream ends only after both sides end, and a relay ends with its socket.
export const socketStream = (socket: WebSocket) => {
  const stream = createWebSocketStream(socket);
  stream.on("error", () => {});
  socket.once("close", () => stream.destroy());
  return stream;
};
