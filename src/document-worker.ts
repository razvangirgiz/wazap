/**
 * The document worker: one thread per document read, so a PDF's parse or an
 * Office file's XML never holds the event loop, and a hostile file that
 * exhausts memory or loops ends this thread (by its resource limits, or the
 * timeout in src/documents.ts), not the server. Its console is not the
 * server's stderr guard: anything pdf.js prints is silenced here, and the
 * thread's own stdout is drained by the parent, so nothing reaches the MCP
 * channel.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractText, type TextJob } from "./document-text.js";

const quiet = (): void => {};
console.log = quiet;
console.info = quiet;
console.debug = quiet;
console.warn = quiet;
console.error = quiet;

const job = workerData as TextJob;
extractText(job).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (err: unknown) => parentPort?.postMessage({ ok: false, message: err instanceof Error ? err.message.split("\n")[0] : "unreadable" })
);
