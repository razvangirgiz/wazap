import { Worker } from "node:worker_threads";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { WazapError } from "./errors.js";
export interface ArchiveRow {
  sid: string;
  jid: string;
  ts: number;
  sender: string;
  type: string;
  text: string;
  raw: string;
  extra?: any;
  deleted?: number;
  edited?: number;
  expires?: number | null;
  quoted?: string | null;
}
export class Archive {
  private worker: Worker | null = null;
  private seq = 0;
  private closing = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  error: string | null = null;
  migrated = false;
  async open(file: string, owner: string): Promise<void> {
    if (file !== ":memory:") {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const fd = await open(file, "a", 0o600);
      await fd.close();
      await chmod(file, 0o600);
    }
    this.worker = new Worker(new URL("./archive-worker.js", import.meta.url), {
      // The compiled worker needs no CLI flags. Node 24's test runner also
      // exposes process-only V8 flags that Worker rejects when passed explicitly.
      execArgv: [],
    });
    this.worker.on("message", ({ id, result, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) {
        this.error = error;
        p.reject(new WazapError("ARCHIVE_UNAVAILABLE", error));
      } else p.resolve(result);
      if (!this.pending.size) this.worker?.unref();
    });
    this.worker.on("error", (e) => {
      this.error = e.message;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    this.worker.on("exit", (code) => {
      if (!this.closing) this.error ??= `Archive worker stopped unexpectedly (${code})`;
      for (const pending of this.pending.values())
        pending.reject(new WazapError("ARCHIVE_UNAVAILABLE", this.error ?? "Archive closed"));
      this.pending.clear();
      this.worker = null;
    });
    const result = await this.call("open", { file, owner });
    this.migrated = result.migrated;
    if (file !== ":memory:") await chmod(file, 0o600);
  }
  call(op: string, args: any = {}): Promise<any> {
    if (!this.worker) return Promise.reject(new WazapError("ARCHIVE_UNAVAILABLE", "Archive is not open"));
    this.worker.ref();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, op, args });
    });
  }
  async close(): Promise<void> {
    if (!this.worker) return;
    this.closing = true;
    const worker = this.worker;
    try {
      await this.call("close");
    } finally {
      await worker.terminate();
      this.worker = null;
    }
  }
}

/** Inspect without creating a database, applying migrations or changing its owner. */
export async function inspectArchive(
  file: string,
): Promise<{ migrated: boolean; owner: string; unknown_sends: number }> {
  const worker = new Worker(new URL("./archive-worker.js", import.meta.url), {
    execArgv: [],
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", ({ result, error }) => (error ? reject(new Error(error)) : resolve(result)));
      worker.once("error", reject);
      worker.postMessage({ id: 1, op: "inspect", args: { file } });
    });
  } finally {
    await worker.terminate();
  }
}
