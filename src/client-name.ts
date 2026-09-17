/**
 * What catch_up keeps a client's mark under when its session is local — stdio,
 * the daemon's loopback bridge, anonymous loopback reads — where no credential
 * names it: the MCP client's own name, `local:<clientInfo.name>`, so Claude
 * Code and Cursor on one machine do not share one mark. A bridge is itself the
 * daemon's client, so it passes its own client's name on in each tool call's
 * `_meta` under CLIENT_META_KEY.
 */

/** A tool call's `_meta` key for the client a bridge serves. */
export const CLIENT_META_KEY = "wazap/client";

export const LOCAL_CLIENT = "local";

/**
 * Whether the session is an assistant talking to a person: stdio and the
 * daemon's bridge (`local`, `local:<client>`), and a hosted agent that signed
 * in (`oauth:<client_id>`). A static token (`token:<label>`) is a builder's own
 * program, which brings its own approval flow, so rules written for the turns
 * of a conversation are not applied to it.
 */
export function isAssistantClient(client: string): boolean {
  return client === LOCAL_CLIENT || client.startsWith(`${LOCAL_CLIENT}:`) || client.startsWith("oauth:");
}

/** `local:<name>` on one line and at most 64 characters; `local` for a client that gave no name. */
export function localClient(name: unknown): string {
  if (typeof name !== "string") return LOCAL_CLIENT;
  const flat = [...name.replace(/[\s\p{Cc}]+/gu, " ").trim()].slice(0, 64).join("");
  return flat === "" ? LOCAL_CLIENT : `${LOCAL_CLIENT}:${flat}`;
}
