// Workers open outbound sockets with an https URL plus an Upgrade header, which also lets us set Authorization.
export async function connectWebSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const response = await fetch(url, {
    headers: { Upgrade: "websocket", ...headers },
    signal: AbortSignal.timeout(5000),
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`WebSocket upgrade failed for ${new URL(url).host}: ${response.status}`);
  socket.accept();
  return socket;
}
