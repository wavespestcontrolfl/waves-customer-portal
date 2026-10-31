import { API_URL, REQUEST_TIMEOUT_MS } from './config.js';

export class IdentifyError extends Error {
  constructor(kind, serverMessage = null) {
    super(serverMessage || kind);
    this.kind = kind;
    this.serverMessage = serverMessage;
  }
}

// docs/public-route-contracts.md, /api/public/bug-id-extension/identify.
const KIND_BY_STATUS = { 400: 'bad_photo', 404: 'unavailable', 413: 'too_large', 429: 'limit', 503: 'busy' };

/** POST 1–3 `{ data, mimeType }` photos; resolves the engine's v2 answer. */
export async function identify(photos) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos }),
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch {
      throw new IdentifyError(controller.signal.aborted ? 'timeout' : 'network');
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok && body && body.success && body.result && body.result.answer) return body.result;
    const message = body && typeof body.error === 'string' ? body.error : null;
    throw new IdentifyError(res.ok ? 'server' : (KIND_BY_STATUS[res.status] || 'server'), message);
  } catch (err) {
    if (err instanceof IdentifyError) throw err;
    throw new IdentifyError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}
