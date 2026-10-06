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

// One clip as the multipart body both transcription routes take.
function clipForm(blob, durationSeconds) {
  const form = new FormData();
  const type = (blob.type || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm";
  form.append("audio", blob, `dictation.${ext}`);
  // Recorded seconds feed the server's transcript plausibility guard.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    form.append("duration_seconds", String(Math.round(durationSeconds)));
  }
  return form;
}

async function postClip(url, blob, durationSeconds, token) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: clipForm(blob, durationSeconds) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || `Transcription failed (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  return String(data?.text || "").trim();
}

/**
 * Sends one clip and returns the words. Only ids go with it, in the query string
 * (the server checks them before it reads the clip, and builds the transcriber's
 * word list from its own records). Throws an Error carrying `status` when the
 * server refuses.
 */
export function transcribeOnServer(blob, durationSeconds, { customerId, serviceId } = {}, token) {
  const ids = new URLSearchParams();
  if (customerId) ids.set("customer_id", String(customerId));
  if (serviceId) ids.set("service_id", String(serviceId));
  const query = ids.toString();
  return postClip(`${API_BASE}/tech/dictation${query ? `?${query}` : ""}`, blob, durationSeconds, token);
}

/** One clip to words by the path the recording was made for (`clip.server`, else the per-visit route). */
export function transcribeClip(blob, durationSeconds, clip, token) {
  return clip.server
    ? transcribeOnServer(blob, durationSeconds, clip, token)
    : transcribeServiceClip(blob, durationSeconds, clip.serviceId, token);
}

/** The older per-visit upload (GATE_TECH_DICTATION_UPLOAD): the same clip, the visit's own route. */
export function transcribeServiceClip(blob, durationSeconds, serviceId, token) {
  return postClip(`${API_BASE}/tech/services/${encodeURIComponent(serviceId)}/dictation`, blob, durationSeconds, token);
}

/**
 * What a mic's words are FOR: the customer and visit ids of its field, and the
 * key a finished transcript is checked against. A visit id given for the older
 * upload path doubles as the visit context.
 */
export function dictationTarget(options, server = false) {
  const customerId = options.dictationContext?.customerId || null;
  const serviceId = options.dictationContext?.serviceId || options.uploadServiceId || null;
  return { customerId, serviceId, server, key: `${customerId || ""}|${serviceId || ""}` };
}

/** The mic's path: "speech" (browser), "upload" (record, then transcribe) or null (no mic). */
export function pickMode({ clipMode, recorderSupported, serverMode, speechSupported, uploadAvailable }) {
  if (clipMode) return recorderSupported ? "upload" : null;
  if (serverMode) return "upload";
  if (speechSupported) return "speech";
  return uploadAvailable ? "upload" : null;
}

// One microphone records at a time, app-wide: two mics on one page (invoice
// notes and thank-you) would otherwise each hear both. Claiming the slot stops
// the mic that holds it, which hands over what it recorded as usual.
let activeRecorder = null;

function claimRecorder(owner) {
  const previous = activeRecorder;
  activeRecorder = owner;
  if (previous && previous !== owner) previous.stop();
}

function releaseRecorder(owner) {
  if (activeRecorder === owner) activeRecorder = null;
}

/**
 * Takes the microphone slot for one recording attempt. `stopRecorder` ends this
 * mic's recording (if it has started one) when another mic claims the slot;
 * `cancelled()` tells a mic still opening that it lost the slot and must not start.
 */
export function openRecorderSlot(stopRecorder) {
  let cancelled = false;
  const owner = {
    stop: () => {
      cancelled = true;
      stopRecorder();
    },
  };
  claimRecorder(owner);
  return { cancelled: () => cancelled, release: () => releaseRecorder(owner) };
}

/** The first container this browser's recorder supports, in the order the server's transcriber likes them. */
export function pickRecorderMime() {
  const supports = window.MediaRecorder.isTypeSupported;
  if (typeof supports !== "function") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => window.MediaRecorder.isTypeSupported(t));
}

/**
 * The hidden-page and cutoff guard for a clip recording: the recording stops
 * (`stopRecording`) when the page is hidden or closing, or after `maxMs`.
 * Returns the function that takes the guard off, or null when the page is
 * already hidden (the clip must not start).
 */
export function guardRecording(stopRecording, maxMs) {
  if (document.visibilityState === "hidden") return null;
  const onHidden = () => {
    if (document.visibilityState === "hidden") stopRecording();
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", stopRecording);
  const cutoffTimer = setTimeout(stopRecording, maxMs);
  return () => {
    clearTimeout(cutoffTimer);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", stopRecording);
  };
}

/** Stops a recorder; one that already stopped (or is gone) is not an error. */
export function stopQuietly(recorder) {
  try {
    recorder?.stop();
  } catch {
    /* already stopped */
  }
}
