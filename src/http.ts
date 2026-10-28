export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count actual bytes, including chunked bodies with no Content-Length. */
export async function readJsonObject(request: Request, limit: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new RequestError("Too large", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("Bad JSON", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError("Too large", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw new Error();
    return value;
  } catch { throw new RequestError("Bad JSON object", 400); }
}

export interface ByteRange { offset: number; length: number }

/** The gateway supports one byte range. Invalid/multiple ranges return 416. */
export function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0 || !Number.isSafeInteger(size)) return null;
  const [, start, end] = match;
  if (!start && !end) return null;
  if (!start) {
    const suffix = Number(end);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(start);
  const last = end ? Number(end) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(last) || offset >= size || last < offset) return null;
  return { offset, length: Math.min(last, size - 1) - offset + 1 };
}
