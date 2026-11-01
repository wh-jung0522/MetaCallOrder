const CONNECT_TIMEOUT_MS = 5000;

// Workers open outbound sockets with an https URL plus an Upgrade header, which also lets us set Authorization.
export async function connectWebSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  // The fetch signal stays bound to the upgraded socket, so the timeout must not outlive the handshake.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`WebSocket connect timed out for ${new URL(url).host}`)), CONNECT_TIMEOUT_MS);
  const response = await fetch(url, { headers: { Upgrade: "websocket", ...headers }, signal: abort.signal }).finally(() => clearTimeout(timer));
  const socket = response.webSocket;
  if (!socket) throw new Error(`WebSocket upgrade failed for ${new URL(url).host}: ${response.status}`);
  socket.accept();
  return socket;
}
