// Synthetic downloader worker: IPC coordination only, never a real HTTP request.
import { downloadFile } from "../../dist/transcribe/models.js";
const { opts, payload, mode = "full" } = JSON.parse(process.argv[2]);
const bytes = Buffer.from(payload);
const controller = new AbortController();
let finish;
process.on("message", (message) => {
  if (message === "finish") finish?.();
  if (message === "abort") controller.abort();
});
globalThis.fetch = async (_url, init) => {
  const start = Number(/^bytes=(\d+)-$/.exec(init.headers.Range ?? "")?.[1] ?? 0);
  process.send({ kind: "fetch", start });
  if (mode === "fail") return new Response(null, { status: 503 });
  const body = new ReadableStream({
    start(c) {
      if (mode === "hold") {
        const split = Math.min(start + 32, bytes.length);
        c.enqueue(bytes.subarray(start, split));
        finish = () => {
          c.enqueue(bytes.subarray(split));
          c.close();
        };
      } else {
        c.enqueue(bytes.subarray(start));
        c.close();
      }
    },
  });
  return new Response(body, {
    status: start ? 206 : 200,
    headers: start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {},
  });
};
try {
  const result = await downloadFile({ ...opts, signal: controller.signal });
  process.send({ kind: "result", ok: true, result });
} catch (err) {
  process.send({ kind: "result", ok: false, code: err.code, message: err.message, fix: err.fix });
} finally {
  process.disconnect();
}
