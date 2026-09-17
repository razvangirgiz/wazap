#!/usr/bin/env node
/**
 * The one-click install link, printed as the markdown the README carries. It
 * encodes the same MCP entry `wazap connect` would write, so regenerating beats
 * hand-editing an encoded blob nobody can read.
 *
 * Cursor:  https://cursor.com/docs/mcp/install-links
 */
import { fileURLToPath } from "node:url";

/** The name the server is registered under, the same one `wazap connect` writes. */
export const NAME = "whatsapp";
export const ENTRY = { command: "npx", args: ["-y", "wazap-mcp"] };

/**
 * base64url, not plain base64. Cursor reads the config through URLSearchParams,
 * which turns a `+` into a space and corrupts the payload; base64url has none,
 * and Cursor's own decoder accepts it.
 */
export function cursorLink() {
  const config = Buffer.from(JSON.stringify(ENTRY)).toString("base64url");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${config}`;
}

export function markdown() {
  return `[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](${cursorLink()})`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(markdown());
}
