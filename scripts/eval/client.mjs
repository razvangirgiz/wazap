/**
 * Small clients for the evaluation server: MCP over Streamable HTTP (the
 * handshake, then tools/call) and its control API. Used by the harness test's
 * scripted agents, the manual protocol and quick probes.
 */

function envelopeOf(text) {
  if (!text) return null;
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .at(-1);
  return data ? JSON.parse(data) : null;
}

/** An MCP session on `url` with a bearer `token`. */
export async function mcpSession(url, token, clientInfo = { name: "eval-client", version: "1" }) {
  let session;
  let nextId = 0;
  const post = async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    session ??= res.headers.get("mcp-session-id") ?? undefined;
    const text = await res.text();
    if (!res.ok && res.status !== 202) throw new Error(`MCP ${body.method} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    return envelopeOf(text);
  };
  const init = await post({
    jsonrpc: "2.0",
    id: ++nextId,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await post({ jsonrpc: "2.0", id: ++nextId, method: "tools/list", params: {} });
  return {
    get id() {
      return session;
    },
    instructions: init?.result?.instructions ?? "",
    tools: listed?.result?.tools ?? [],
    async call(name, args = {}) {
      const reply = await post({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } });
      if (reply?.error) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    },
    async close() {
      if (!session) return;
      await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": session } }).catch(() => {});
    },
  };
}

/** The control API of a running evaluation server. */
export function controlClient(controlUrl, controlToken) {
  const request = async (method, path, body) => {
    const res = await fetch(`${controlUrl}${path}`, {
      method,
      headers: { "x-eval-control": controlToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`control ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return data;
  };
  return {
    state: () => request("GET", "/eval/state"),
    trace: () => request("GET", "/eval/trace"),
    effects: () => request("GET", "/eval/effects"),
    refs: () => request("GET", "/eval/refs"),
    info: () => request("GET", "/eval/info"),
    reset: (body = {}) => request("POST", "/eval/reset", body),
    turn: (turn, session, label) => request("POST", "/eval/turn", { turn, session, label }),
    hooks: (hooks) => request("POST", "/eval/hooks", { hooks }),
    stop: () => request("POST", "/eval/stop", {}),
  };
}
