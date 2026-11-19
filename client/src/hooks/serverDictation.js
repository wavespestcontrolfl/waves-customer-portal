// Server dictation (GATE_SERVER_DICTATION): every staff mic records a clip and
// our server transcribes it (POST /api/tech/dictation) instead of the browser's
// speech recognition. This module is the client half of that endpoint: the
// per-session availability answer and the clip upload. See useSpeechDictation.js.
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// One answer per session (per login token): { token, value, liveWords } once the server has
// said yes or no (liveWords: it will also stream the words while the person talks), and the request still in flight so mics mounting together share
// one call. A failed request is not remembered, so the next mic asks again.
let answered = null;
let inFlight = null;

/** The remembered answer for this login, or undefined when the server has not been asked yet. */
export function knownServerDictation(token) {
  return answered && answered.token === token ? answered.value : undefined;
}

/** True when the server said it will show live words (GATE_DICTATION_LIVE_WORDS) for this login. */
export function knownLiveWords(token) {
  return answered && answered.token === token ? answered.liveWords === true : false;
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
      // `everyBox` (GATE_DICTATION_EVERY_BOX) rides beside it: the staff-wide mic on text boxes with none.
      answered = { token, value, everyBox: value && d.everyBox === true, liveWords: value && d.liveWords === true };
      return value;
    })
    .catch(() => false)
    .finally(() => {
      if (inFlight && inFlight.promise === promise) inFlight = null;
    });
  inFlight = { token, promise };
  return promise;
}

/** True when the server also wants the one Waves mic on every staff text box (FocusedBoxMic). Never rejects. */
export async function checkEveryBoxDictation(token) {
  await checkServerDictation(token);
  return Boolean(token && answered && answered.token === token && answered.everyBox === true);
}

/** Asks the server again (the gate may have changed). The every-box answer, or null when the server could not be reached. */
export async function refreshEveryBoxDictation(token) {
  forgetServerDictation();
  await checkServerDictation(token);
  return answered && answered.token === token ? answered.everyBox === true : null;
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

// A send that got no answer: fetch() rejected (iOS shows a bare "Load failed"; owner 2026-11-06
// 10:49, the IB mic: the server got the request headers and no audio), or a 2xx answer was cut
// off before its words (reading `{}` there used to drop the recording without a word).
// `unsent` lets the hook offer to send the same recording again.
export const UNSENT_MESSAGE = "The words did not come back.";
function unsentError() {
  const err = new Error(UNSENT_MESSAGE);
  err.unsent = true;
  return err;
}

async function postClip(url, blob, durationSeconds, token) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: clipForm(blob, durationSeconds) });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw unsentError();
  }
  // A refusal's body is optional; a 2xx body that cannot be read is a send with no answer.
  const data = r.ok ? await r.json().catch(() => { throw unsentError(); }) : await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || `Transcription failed (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  // `money` (GATE_DICTATION_MONEY_NORMALIZE) rides beside the words when the server sends it.
  return { text: String(data?.text || "").trim(), money: data?.money && typeof data.money === "object" ? data.money : null };
}

/**
 * Sends one clip and returns { text, money } (the words, and the server's dictated-amount notes when it sends them). Only ids go with it, in the query string
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

// Worded for both cases: no answer at all, or a 2xx answer cut off (the server may have heard it).
export const RESEND_QUESTION = `${UNSENT_MESSAGE} Send the recording again?`;

// A hidden page (the app went to the background as the recording stopped) may not show a
// question at all, and a suppressed confirm() reads as "no": ask only once the page is back.
// `signal` (the mic unmounted) ends the wait at once, so the recording is let go.
function pageVisible(signal) {
  if (document.visibilityState !== "hidden" || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener("visibilitychange", onChange);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState !== "hidden") done();
    };
    document.addEventListener("visibilitychange", onChange);
    signal?.addEventListener("abort", done);
  });
}

/**
 * transcribeClip, and when a send got no answer while `canResend()` holds (the field is still
 * there and still this recording's), asks to send the SAME recording again, once the page is
 * visible. Never automatic: when only the answer was lost, the server already paid for those
 * words. Resolves null when the person says no; throws the unsent error when the field moved on.
 * `signal` aborts when the mic unmounts: a wait for the page then ends at once.
 */
export async function transcribeClipWithResend(blob, durationSeconds, clip, token, canResend, signal) {
  for (;;) {
    try {
      return await transcribeClip(blob, durationSeconds, clip, token);
    } catch (e) {
      if (!e?.unsent || !canResend()) throw e;
      await pageVisible(signal);
      if (!canResend()) throw e;
      if (!window.confirm(RESEND_QUESTION)) return null;
      // Another tab can sign out or switch login while the question is open: check again.
      if (!canResend()) throw e;
    }
  }
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
 * `cancelled()` tells a mic still opening that it lost the slot (or was cancelled
 * with `cancel()`) and must not start.
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
  return { cancelled: () => cancelled, cancel: owner.stop, release: () => releaseRecorder(owner) };
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
