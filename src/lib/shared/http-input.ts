export class RequestBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) { super(message); }
}

/** Enforce the limit while reading, including chunked bodies without Content-Length. */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    // Do not await cancellation: an untrusted producer may never finish its cancel hook.
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyError("Request too large", 413);
  }
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyError("Request too large", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length).toString("utf8");
}

export async function readJsonBody(request: Request, maxBytes: number, allowEmpty = false): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  try { return allowEmpty && !text ? {} : JSON.parse(text); }
  catch { throw new RequestBodyError("Invalid JSON", 400); }
}
