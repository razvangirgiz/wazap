/**
 * Shared plumbing for the tests that drive the built binary: spawning it against
 * a throwaway data dir, talking MCP JSON-RPC over its stdio, and waiting on a
 * condition instead of sleeping.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BINARY = join(repoRoot, "dist", "index.js");

/**
 * Spawn `dist/index.js` against `dataDir` with every stream piped. The returned
 * `stderr` array collects the child's log lines as they arrive.
 */
export function spawnWazap({ dataDir, args = [], env = {}, binary = BINARY } = {}) {
  const child = spawn(process.execPath, [binary, ...args, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WAZAP_READ_TOKEN: "", WAZAP_WRITE_TOKEN: "", ...env },
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
