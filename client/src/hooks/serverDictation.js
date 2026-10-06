// Server dictation (GATE_SERVER_DICTATION): every staff mic records a clip and
// our server transcribes it (POST /api/tech/dictation) instead of the browser's
// speech recognition. This module is the client half of that endpoint: the
// per-session availability answer and the clip upload. See useSpeechDictation.js.
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// One answer per session (per login token): { token, value } once the server has
// said yes or no, and the request still in flight so mics mounting together share
// one call. A failed request is not remembered, so the next mic asks again.
let answered = null;
let inFlight = null;

/** The remembered answer for this login, or undefined when the server has not been asked yet. */
export function knownServerDictation(token) {
  return answered && answered.token === token ? answered.value : undefined;
}

/** True when the server will transcribe clips (gate on and a transcriber key set). Never rejects. */
export function checkServerDictation(token) {
  if (!token) return Promise.resolve(false);
  const known = knownServerDictation(token);
  if (known !== undefined) return Promise.resolve(known);
  if (inFlight && inFlight.token === token) return inFlight.promise;
  const promise = fetch(`${API_BASE}/tech/dictation/availability`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return false;
      const value = d.available === true;
      answered = { token, value };
      return value;
    })
    .catch(() => false)
    .finally(() => {
      if (inFlight && inFlight.promise === promise) inFlight = null;
    });
  inFlight = { token, promise };
  return promise;
}

/** Drop the remembered answer (the server said 404: the gate went off mid-session). */
export function forgetServerDictation() {
  answered = null;
  inFlight = null;
}

/**
 * Sends one clip and returns the words. Only ids go with it: the server builds
 * the transcriber's word list from its own records. Throws an Error carrying
 * `status` when the server refuses.
 */
export async function transcribeOnServer(blob, durationSeconds, { customerId, serviceId } = {}, token) {
  const form = new FormData();
  const type = (blob.type || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm";
  form.append("audio", blob, `dictation.${ext}`);
  // Recorded seconds feed the server's transcript plausibility guard.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    form.append("duration_seconds", String(Math.round(durationSeconds)));
  }
  if (customerId) form.append("customer_id", String(customerId));
  if (serviceId) form.append("service_id", String(serviceId));
  const r = await fetch(`${API_BASE}/tech/dictation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || `Transcription failed (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  return String(data?.text || "").trim();
}
