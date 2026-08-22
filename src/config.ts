/**
 * Configuration loading.
 *
 * The .env file, the WhatsApp session folder and the QR image live next to the
 * package root (resolved from this file's location), not the current working
 * directory, so the session survives no matter where an MCP client launches
 * the process from.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

export interface Config {
  /** Absolute path to the Baileys session/auth folder. */
  authPath: string;
  /** Absolute path to the QR PNG written on first login. */
  qrFile: string;
  /**
   * Make the connection read-only: every send/mutation is refused, so an
   * accidental MCP call can never message anyone from this account. Default false.
   */
  readOnly: boolean;
  /** Ask WhatsApp to sync fuller history on connect. Default false. */
  syncFullHistory: boolean;
  /**
   * Directory (relative to package root) for a durable message journal.
   * null = journaling off.
   */
  journalDir: string | null;
  /**
   * File (relative to package root) for the store snapshot, so the chat list
   * and recent messages survive restarts. null = no persistence.
   */
  storeCacheFile: string | null;
  /**
   * Directory (relative to package root) for the per-chat history store. When
   * set, messages from history sync and live traffic are persisted as per-chat
   * JSONL files. null = disabled.
   */
  historyStoreDir: string | null;
  /** MCP transport: "stdio" (default, for Claude Desktop/Code) or "http". */
  transport: "stdio" | "http";
  /** Host to bind in http mode (default 127.0.0.1). */
  httpHost: string;
  /** Port to bind in http mode (default 8766). */
  httpPort: number;
  /**
   * Bearer token required on the http /mcp endpoint. null = no auth, which is
   * only acceptable on loopback. Never expose an unauthenticated server.
   */
  authToken: string | null;
  /**
   * Write token: requests authenticated with it get the mutating tools
   * (send/media/react/forward/delete/manage). Keep it separate from the read
   * token so a leaked read token cannot message anyone. null = no write access
   * over HTTP.
   */
  writeToken: string | null;
  /** Absolute package root. */
  pkgRoot: string;
}

/** Package root: this file is at <root>/dist/config.js or <root>/src/config.ts. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(): Config {
  const pkgRoot = packageRoot();
  dotenv.config({ path: resolve(pkgRoot, ".env") });

  return {
    authPath: process.env.WHATSAPP_AUTH_PATH
      ? resolve(pkgRoot, process.env.WHATSAPP_AUTH_PATH)
      : resolve(pkgRoot, ".baileys_auth"),
    qrFile: process.env.QR_FILE ? resolve(pkgRoot, process.env.QR_FILE) : resolve(pkgRoot, "qr.png"),
    readOnly: asBool(process.env.WHATSAPP_READONLY, false),
    syncFullHistory: asBool(process.env.WHATSAPP_SYNC_FULL_HISTORY, false),
    journalDir: (process.env.WHATSAPP_JOURNAL_DIR ?? "").trim() || null,
    storeCacheFile: (process.env.WHATSAPP_STORE_CACHE ?? "").trim() || null,
    historyStoreDir: (process.env.WHATSAPP_HISTORY_STORE_DIR ?? "").trim() || null,
    transport: process.env.TRANSPORT?.trim().toLowerCase() === "http" ? "http" : "stdio",
    httpHost: process.env.HOST?.trim() || "127.0.0.1",
    httpPort: Number.parseInt(process.env.PORT ?? "", 10) || 8766,
    authToken: (process.env.MCP_AUTH_TOKEN ?? "").trim() || null,
    writeToken: (process.env.MCP_WRITE_TOKEN ?? "").trim() || null,
    pkgRoot,
  };
}
