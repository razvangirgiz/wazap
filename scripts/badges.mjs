#!/usr/bin/env node
/**
 * The one-click install links, printed as the markdown the README carries.
 * Both encode the same MCP entry `wazap connect` would write, so regenerating
 * beats hand-editing an encoded blob nobody can read.
 *
 * Cursor:  https://cursor.com/docs/mcp/install-links
 * VS Code: https://code.visualstudio.com/api/extension-guides/ai/mcp
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

/** VS Code takes the whole server object with its name folded in, URL-encoded. */
export function vscodeLink(scheme = "vscode") {
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, ...ENTRY }))}`;
}

/** The https form, for the many places a custom scheme is stripped before it can be clicked. */
export function vscodeRedirect() {
  return `https://insiders.vscode.dev/redirect/mcp/install?name=${NAME}&config=${encodeURIComponent(JSON.stringify(ENTRY))}`;
}

export function markdown() {
  return [
    `[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](${cursorLink()})`,
    `[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](${vscodeLink()})`,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(markdown());
  console.log(`\nIf a custom scheme is stripped, VS Code also takes:\n${vscodeRedirect()}`);
}
