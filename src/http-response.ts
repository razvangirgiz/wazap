/** Release ignored response bodies without reading provider-controlled content. */
export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export class ResponseLimitError extends Error {
  constructor() {
    super("HTTP response exceeded the size limit.");
    this.name = "ResponseLimitError";
  }
}

/** Bound actual decoded bytes, even with no (or a misleading) Content-Length. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await discardResponse(response);
    throw new ResponseLimitError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty HTTP response.");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ResponseLimitError();
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
