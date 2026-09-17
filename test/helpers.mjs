/**
 * Shared plumbing for the tests that drive the built binary: spawning it against
 * a throwaway data dir, talking MCP JSON-RPC over its stdio, and waiting on a
 * condition instead of sleeping.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";

import { singletonSource } from "../dist/account-hub.js";
import { accountPaths } from "../dist/config.js";
import { sqlite } from "../dist/db/sqlite.js";
import { DRAFT_TTL_MS, DraftStore, draftExpired, draftNotFound, formatDraftPreview } from "../dist/drafts.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BINARY = join(repoRoot, "dist", "index.js");

/**
 * A child's environment must not inherit the developer's WAZAP_* shell.
 * `WAZAP_WEBHOOK=on` would post test messages to a real receiver, and
 * `WAZAP_NO_SHARE=1` skips daemon.json. Tests pass explicit overrides in `extra`.
 */
export function childEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WAZAP_")));
  return { ...env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_READ_TOKEN: "", WAZAP_WRITE_TOKEN: "", ...extra };
}

/**
 * Spawn `dist/index.js` against `dataDir` with every stream piped. The returned
 * `stderr` array collects the child's log lines as they arrive.
 */
export function spawnWazap({ dataDir, args = [], env = {}, binary = BINARY } = {}) {
  const child = spawn(process.execPath, [binary, ...args, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(env),
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  return { child, stderr };
}

/** Newline-delimited JSON-RPC over the child's stdio, the framing an MCP client uses. */
export function mcpClient(child) {
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  return { request, notify };
}

/** Poll until `predicate` returns something truthy, or reject naming what we waited for. */
export async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** Config for a service that talks to nobody and writes nothing. */
export function offlineConfig(prefix, overrides = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), prefix)),
    readOnly: true,
    syncFullHistory: false,
    persistHistory: false,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 8766,
    readToken: null,
    writeToken: null,
    rateLimitPerMinute: 20,
    command: "serve",
    loginCode: false,
    ...overrides,
  };
}

/**
 * Minimal stand-in for a Baileys socket: the event surface wireEvents and
 * linkSession use, plus the pairing code and the user a link settles on. `end`
 * announces the close the way the real socket does, so a caller waiting on
 * `connection.update` is not left hanging.
 */
export function fakeSocket({ pairingCode = "ABCD1234", user } = {}) {
  const listeners = new Map();
  const sock = {
    user,
    ended: false,
    requestPairingCode: async () => pairingCode,
    ev: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeAllListeners(event) {
        listeners.delete(event);
      },
      emit(event, arg) {
        for (const fn of listeners.get(event) ?? []) fn(arg);
      },
    },
    end() {
      sock.ended = true;
      sock.ev.emit("connection.update", { connection: "close" });
    },
  };
  return sock;
}

/**
 * Hand `sockets` to pairing.ts in order, in place of the real Baileys factory.
 * `opened` grows as each one is taken, which is what a test waits on before it
 * starts emitting events at it.
 */
export function stubSockets(socketFactory, sockets) {
  const original = socketFactory.open;
  const opened = [];
  socketFactory.open = () => {
    const sock = sockets[opened.length] ?? sockets.at(-1);
    opened.push(sock);
    return sock;
  };
  return { opened, restore: () => (socketFactory.open = original) };
}

export const DEFAULT_ACCOUNT = Object.freeze({ id: "default", name: "default", enabled: true, owner: null });

/** Build a service the same way production does after the constructor grew an account. */
export function openService(WhatsAppService, config, account = DEFAULT_ACCOUNT) {
  return new WhatsAppService(config, { ...account }, accountPaths(config.dataDir, account.id));
}

/** Enough of an AccountHub for HTTP tests that only need one stub WhatsApp. */
export function stubAccountSource(wa) {
  return singletonSource(wa);
}

/**
 * The draft half of a WhatsAppApi stand-in, in memory: put a payload against a
 * recipient, view it the way the service does, and take it once, with the
 * service's DRAFT_NOT_FOUND and DRAFT_EXPIRED. The service's own drafts live in
 * the account database; that store has its own tests.
 */
export function draftStub(now = Date.now, ttlMs = DRAFT_TTL_MS) {
  const drafts = new Map();
  const views = new DraftStore(now, ttlMs);
  return {
    put(to, payload) {
      const id = `d_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const draft = { id, to, payload, preview: formatDraftPreview(to, payload), expiresAt: now() + ttlMs, keyId: id };
      drafts.set(id, draft);
      return draft;
    },
    view: (draft) => views.view(draft),
    take(id) {
      const draft = drafts.get(id);
      if (draft === undefined) throw draftNotFound(id);
      drafts.delete(id);
      if (draft.expiresAt <= now()) throw draftExpired(id);
      return draft;
    },
  };
}

/** registerTools takes an AccountSource. Stubs and live services go through here. */
export function asToolSource(source) {
  if (source && typeof source.bindings === "function" && typeof source.defaultBinding === "function") {
    return source;
  }
  return singletonSource(source && typeof source === "object" ? source : {});
}

/** A connected service fed only by events, so no socket and no disk are involved. */
export function connectedService(WhatsAppService, { prefix, id, name, config = {}, account } = {}) {
  const svc = openService(WhatsAppService, offlineConfig(prefix, config), account);
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name, number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return { svc, sock };
}

/**
 * A connected service that has also run what start() runs before the socket:
 * the account database's boot, which imports legacy files the first time.
 */
export async function bootedService(WhatsAppService, options = {}) {
  const connected = connectedService(WhatsAppService, options);
  await connected.svc.bootStorage();
  return connected;
}

/**
 * Whether any byte of the account database — the file, its write-ahead log
 * and its shared memory — still spells `needle`, after a checkpoint moved the
 * log into the file. What "the payload is gone from the disk" means now.
 */
export function databaseHolds(svc, needle) {
  const db = svc.db;
  db.checkpoint();
  const bytes = Buffer.from(needle);
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${db.path}${suffix}`;
    if (existsSync(path) && readFileSync(path).includes(bytes)) return true;
  }
  return false;
}

/**
 * Rows straight off the account database's file, through a connection of
 * their own: what is stored, whatever an accessor would hide. For asserting
 * that a delete took a message's marks and vector, not that a reader skips them.
 */
export function storageRows(svc, sql, ...params) {
  const { DatabaseSync } = sqlite();
  const reader = new DatabaseSync(svc.databasePath ?? svc.path, { readOnly: true });
  try {
    return reader.prepare(sql).all(...params);
  } finally {
    reader.close();
  }
}

/**
 * What the file still holds for a message, under any spelling of its chat and
 * however deleted: its rows, the rows among them that keep words or a
 * protobuf, and its vector, reactions, votes, receipts and file records.
 */
export function storedMarks(svc, sid) {
  const [, fromMe, key] = /^(true|false)_[^_]+?@[^_]+_(.+)$/.exec(sid);
  const ids = "SELECT id FROM messages WHERE key_id = ? AND from_me = ?";
  const params = [key, fromMe === "true" ? 1 : 0];
  const count = (sql) => storageRows(svc, sql, ...params)[0].n;
  return {
    rows: count(`SELECT count(*) AS n FROM messages WHERE key_id = ? AND from_me = ?`),
    words: count(`SELECT count(*) AS n FROM messages WHERE key_id = ? AND from_me = ? AND (text IS NOT NULL OR transcript IS NOT NULL OR raw IS NOT NULL)`),
    embeddings: count(`SELECT count(*) AS n FROM embeddings WHERE message_id IN (${ids})`),
    reactions: count(`SELECT count(*) AS n FROM reactions WHERE message_id IN (${ids})`),
    votes: count(`SELECT count(*) AS n FROM votes WHERE message_id IN (${ids})`),
    receipts: count(`SELECT count(*) AS n FROM receipts WHERE message_id IN (${ids})`),
    media: count(`SELECT count(*) AS n FROM media WHERE message_id IN (${ids})`),
  };
}

/** Nothing of a deleted message but, at most, the content-free rows of its tombstone. */
export function onlyTombstone(svc, sid) {
  const { rows: _rows, ...marks } = storedMarks(svc, sid);
  return marks;
}

export const NO_MARKS = Object.freeze({ words: 0, embeddings: 0, reactions: 0, votes: 0, receipts: 0, media: 0 });

/** The message ids a chat holds, newest first, as read_messages would page them. */
export function storedIds(svc, chat, limit = 1000) {
  return svc.db.messages.chatPage(chat, { limit }).items.map((message) => message.sid);
}
