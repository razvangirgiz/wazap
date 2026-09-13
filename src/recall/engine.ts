/**
 * The embedding backend: one `llama-server --embedding` child bound to
 * loopback, restarted when it dies, killed when wazap stops. The queue is the
 * only caller, so a slow restart stalls indexing — never ingestion.
 *
 * The /embedding API is stateless, so every account in the process shares one
 * server: the registry below spawns on the first acquire and kills on the
 * last release, keyed by the only things that make a sidecar distinct — the
 * resolved binary and the model file.
 *
 * WAZAP_EMBED_URL points at an already-running compatible server instead of
 * spawning one; that seam exists for the test stub, not as a supported option.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { WazapError } from "../errors.js";
import { which } from "../transcribe/index.js";
import { embedModelPath, type EmbedModelSpec } from "./models.js";
import type { RecallSettings } from "./types.js";

const HEALTH_PATH = "/health";
const EMBED_PATH = "/embedding";
/** Model load takes seconds on a cold start; nothing else is this patient. */
const START_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
const BACKOFF_INIT_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const LLAMA_NAMES = ["llama-server"];

/** The override first, then PATH — the same dance findWhisper does. */
export function findLlama(settings: RecallSettings): string | null {
  const names = settings.embedBin === null ? LLAMA_NAMES : [settings.embedBin, ...LLAMA_NAMES];
  for (const name of names) {
    const found = which(name);
    if (found !== null) return found;
  }
  return null;
}

function llamaInstallFix(): string {
  if (process.platform === "darwin") return "Run `brew install llama.cpp`";
  return "Build llama.cpp from https://github.com/ggml-org/llama.cpp and put llama-server on PATH";
}

/** What a caller needs to know before it can embed: everything or the reason not. */
export interface EmbedReadiness {
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function embedReady(settings: RecallSettings, spec: EmbedModelSpec): Promise<EmbedReadiness> {
  if (settings.embedUrl !== null) return { ok: true, detail: `external embedding server at ${settings.embedUrl}` };
  if (findLlama(settings) === null) {
    return { ok: false, detail: "llama-server not found", fix: llamaInstallFix() };
  }
  const model = embedModelPath(settings.modelsDir, spec);
  try {
    await access(model);
  } catch {
    return { ok: false, detail: `model ${spec.file} is not downloaded`, fix: "Run `wazap embed download`" };
  }
  return { ok: true, detail: `llama-server with ${spec.file}` };
}

interface EmbeddingReply {
  index?: number;
  embedding?: number[][];
}

/** One free loopback port, released before llama-server claims it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  probe.close();
  await once(probe, "close");
  if (port === 0) throw new WazapError("RECALL_FAILED", "Could not find a free loopback port.");
  return port;
}

interface EmbeddingTarget {
  /** Texts go to `${base}${EMBED_PATH}`. */
  base: string;
  /** Resolves once the server answers /health, or immediately for an external URL. */
  waitReady(): Promise<void>;
  stop(): Promise<void>;
}

/** The spawned sidecar: owns a child, restarts it with backoff until stopped. */
class LlamaSidecar implements EmbeddingTarget {
  base = "";
  private child: ChildProcess | null = null;
  private stopping = false;
  private backoff = BACKOFF_INIT_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Set when the current child answers /health; cleared when it exits. */
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly bin: string,
    private readonly model: string,
    private readonly onLog: (line: string) => void
  ) {}

  async start(): Promise<void> {
    const port = await freePort();
    this.base = `http://127.0.0.1:${port}`;
    this.spawnChild();
    await this.waitReady();
  }

  private spawnChild(): void {
    const port = new URL(this.base).port;
    const child = spawn(
      this.bin,
      // -b/-ub at the context size: the default 512-token physical batch
      // rejects any single text over ~512 tokens, and capped texts run longer.
      ["-m", this.model, "--host", "127.0.0.1", "--port", port, "--embedding", "-c", "8192", "-b", "8192", "-ub", "8192"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    this.child = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A restart rejects a promise nobody may be awaiting; that is normal, so
    // the rejection must not count as unhandled.
    this.readyPromise.catch(() => {});
    // llama-server's own log is startup noise; the last lines are kept only so a
    // boot failure can say why. Nothing is forwarded to wazap's stderr.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => this.childFailed(err));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.readyReject?.(new WazapError("RECALL_FAILED", "embedding backend stopped"));
        return;
      }
      const reason = code !== null ? `exit ${code}` : `signal ${signal}`;
      this.onLog(`recall: llama-server ${reason}; restarting in ${Math.round(this.backoff / 1000)}s`);
      this.readyReject?.(new WazapError("RECALL_FAILED", `llama-server ${reason}: ${stderrTail.trimEnd()}`));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) return;
        this.spawnChild();
      }, this.backoff);
      this.restartTimer.unref();
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    });
  }

  private childFailed(err: Error): void {
    if (this.stopping) return;
    this.onLog(`recall: llama-server could not start (${err.message})`);
    this.readyReject?.(err);
  }

  async waitReady(): Promise<void> {
    if (this.readyPromise === null) {
      throw new WazapError("RECALL_FAILED", "embedding backend is not running");
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      try {
        const response = await fetch(`${this.base}${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          this.backoff = BACKOFF_INIT_MS;
          this.readyResolve?.();
          return;
        }
      } catch {
        // Not up yet; the deadline below is the only real stop.
      }
      if (this.stopping) throw new WazapError("RECALL_FAILED", "embedding backend stopped");
      if (this.child === null && this.restartTimer === null) {
        // The child exited between probes; the exit handler already rejected
        // readyPromise, which is the truth a caller should see.
        await this.readyPromise;
        return;
      }
      if (Date.now() > deadline) {
        throw new WazapError(
          "RECALL_FAILED",
          `llama-server did not become healthy within ${START_TIMEOUT_MS / 1000}s`,
          "Run `wazap embed download` again if the model file changed"
        );
      }
      await sleep(250);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.readyReject?.(new WazapError("RECALL_FAILED", "embedding backend stopped"));
    if (child === null) return;
    child.kill("SIGTERM");
    const exited = once(child, "exit").then(() => true);
    if (!(await Promise.race([exited, sleep(KILL_GRACE_MS, false)]))) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
  }
}

/** A backend the tests bring up themselves: no child, no health gate. */
class UrlBackend implements EmbeddingTarget {
  constructor(public readonly base: string) {}
  waitReady(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** A target the registry also owns the lifetime of: start spawns, stop kills. */
interface SpawnedSidecar extends EmbeddingTarget {
  start(): Promise<void>;
}

/** The seam the tests replace; production always spawns a real llama-server. */
export const sidecarFactory = {
  open: (bin: string, model: string, onLog: (line: string) => void): SpawnedSidecar =>
    new LlamaSidecar(bin, model, onLog),
};

/** One row of the registry: the child, its start promise, and who holds it. */
interface SidecarEntry {
  /** Live consumers; the release that takes this to zero kills the server. */
  refs: number;
  sidecar: SpawnedSidecar;
  /**
   * Kept on the entry so two accounts reaching for their first embeddings at
   * once — the boot backfill — await the same spawn rather than each starting
   * a server of their own.
   */
  started: Promise<void>;
}

const sharedSidecars = new Map<string, SidecarEntry>();

/**
 * One consumer's claim on a shared sidecar. Embedding calls reach the child
 * directly; stop() only gives this claim back — the last one out is the one
 * that kills the server. The child's restart lines keep arriving through the
 * first consumer's onLog, which in production is the same `log` for everyone.
 */
class SharedSidecar implements EmbeddingTarget {
  private released = false;

  private constructor(
    private readonly key: string,
    private readonly entry: SidecarEntry
  ) {}

  /** First claim on a key spawns; later ones join the start already under way. */
  static acquire(bin: string, model: string, onLog: (line: string) => void): SharedSidecar {
    const key = `${bin}\n${model}`;
    let entry = sharedSidecars.get(key);
    if (entry === undefined) {
      const sidecar = sidecarFactory.open(bin, model, onLog);
      entry = { refs: 0, sidecar, started: sidecar.start() };
      sharedSidecars.set(key, entry);
      // A failed start frees the slot, so the next acquire spawns fresh
      // instead of joining a rejection. Consumers still holding refs release
      // into a sidecar that never ran — stop() on it is a safe no-op.
      entry.started.catch(() => {
        if (sharedSidecars.get(key) === entry) sharedSidecars.delete(key);
      });
    }
    entry.refs++;
    return new SharedSidecar(key, entry);
  }

  /** The shared start; the engine releases its claim when this rejects. */
  started(): Promise<void> {
    return this.entry.started;
  }

  get base(): string {
    return this.entry.sidecar.base;
  }

  waitReady(): Promise<void> {
    return this.entry.sidecar.waitReady();
  }

  async stop(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.entry.refs--;
    if (this.entry.refs > 0) return;
    if (sharedSidecars.get(this.key) === this.entry) sharedSidecars.delete(this.key);
    await this.entry.sidecar.stop();
  }
}

/**
 * The queue's handle on embeddings. `embed` waits out a restart for up to
 * START_TIMEOUT_MS, then fails the batch — the queue retries, so a dying
 * sidecar stalls indexing rather than dropping messages.
 */
export class EmbedEngine {
  private constructor(
    private readonly target: EmbeddingTarget,
    private readonly spec: EmbedModelSpec
  ) {}

  static async start(
    settings: RecallSettings,
    spec: EmbedModelSpec,
    onLog: (line: string) => void = () => {}
  ): Promise<EmbedEngine> {
    if (settings.embedUrl !== null) {
      const base = settings.embedUrl.replace(/\/+$/, "");
      return new EmbedEngine(new UrlBackend(base), spec);
    }
    const bin = findLlama(settings);
    if (bin === null) {
      throw new WazapError(
        "RECALL_UNAVAILABLE",
        "llama-server not found; semantic recall needs llama.cpp",
        llamaInstallFix()
      );
    }
    // Accounts on the same binary and model share one server: acquire bumps
    // the registry's refcount, this engine's stop() hands just this claim back.
    const target = SharedSidecar.acquire(bin, embedModelPath(settings.modelsDir, spec), onLog);
    try {
      await target.started();
    } catch (err) {
      await target.stop();
      throw err;
    }
    return new EmbedEngine(target, spec);
  }

  /**
   * `kind` picks the model's task prefix: the index holds "document" texts,
   * searches embed "query". The prefix is the model's side of a retrieval
   * pair, not part of what the index stores.
   */
  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.target.waitReady();
    const input = texts.map((text) => `${this.spec.prompts[kind]}${text}`);
    let response: Response;
    try {
      response = await fetch(`${this.target.base}${EMBED_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: input.length === 1 ? input[0] : input }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WazapError(
        "RECALL_FAILED",
        `embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        "Check that llama-server is running"
      );
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new WazapError("RECALL_FAILED", `embedding server answered ${response.status}: ${body}`);
    }
    const reply = (await response.json()) as EmbeddingReply[] | { error?: { message?: string } };
    if (!Array.isArray(reply)) {
      throw new WazapError("RECALL_FAILED", `embedding server refused: ${reply.error?.message ?? "bad reply"}`);
    }
    if (reply.length !== input.length) {
      throw new WazapError(
        "RECALL_FAILED",
        `embedding server returned ${reply.length} vectors for ${texts.length} texts`
      );
    }
    return reply.map((item, i) => {
      const embedding = item.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || !Array.isArray(embedding[0])) {
        throw new WazapError("RECALL_FAILED", `embedding ${i} has no pooled vector`);
      }
      return embedding[0]!;
    });
  }

  async stop(): Promise<void> {
    await this.target.stop();
  }
}
