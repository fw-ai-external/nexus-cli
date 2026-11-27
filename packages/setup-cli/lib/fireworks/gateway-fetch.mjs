import { Buffer } from "node:buffer";

/** Upper bound for gateway verify/catalog HTTP requests (no response → fail fast). */
export const FIREWORKS_GATEWAY_FETCH_TIMEOUT_MS = 30_000;

/**
 * @returns {AbortSignal}
 */
export function fireworksGatewayFetchSignal() {
  return AbortSignal.timeout(FIREWORKS_GATEWAY_FETCH_TIMEOUT_MS);
}

/**
 * A 4xx other than transient 408/429: the gateway answered definitely and
 * retrying won't change it.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDefiniteRefusal(status) {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Parse a JSON HTTP response body while enforcing a strict byte ceiling so an
 * oversized gateway response can never exhaust memory. Never throws.
 * @param {Response | null | undefined} response
 * @param {number} maxBytes
 * @returns {Promise<unknown | null>}
 */
export async function readBoundedJson(response, maxBytes) {
  try {
    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response?.body?.cancel?.().catch(() => {});
      return null;
    }
    if (response?.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const buf = value instanceof Uint8Array ? value : Buffer.from(value);
          total += buf.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(buf);
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
      return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    }
    if (typeof response?.text === "function") {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
      return JSON.parse(text);
    }
    if (typeof response?.json === "function") {
      return await response.json();
    }
    return null;
  } catch {
    return null;
  }
}
