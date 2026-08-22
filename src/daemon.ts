import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How a bridge finds the running server: the loopback port and the token that opens it. */
export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The sidecar another process left behind, or null if it is missing, corrupt or the wrong shape. */
export function readDaemon(file: string): DaemonInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { pid, port, token, version } = parsed as Record<string, unknown>;
  if (!isPositiveInt(pid) || !isPositiveInt(port)) return null;
  if (typeof token !== "string" || token === "") return null;
  if (typeof version !== "string" || version === "") return null;
  return { pid, port, token, version };
}

export function writeDaemon(file: string, info: DaemonInfo): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  // mode only applies when the file is created, so a looser file left by an
  // earlier run would keep its permissions and expose the token.
  chmodSync(file, 0o600);
}

/** Remove the sidecar, but only if it is still ours. */
export function removeDaemon(file: string): void {
  try {
    if (readDaemon(file)?.pid !== process.pid) return;
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** Liveness of the loopback endpoint recorded in a sidecar. Never throws. */
export async function daemonHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
