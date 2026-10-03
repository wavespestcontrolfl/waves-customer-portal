import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// A browser SpeechRecognition session ends itself after a few seconds of
// silence even with `continuous = true`. The SPEECH path below restarts the
// same instance on every such `onend` so dictation keeps listening through
// normal pauses, until the tech taps stop. See IDLE_STOP_MS below for the
// one time-based cutoff that still ends it on its own.
const IDLE_STOP_MS = 60000;
// Clip mode: the longest one recording runs. A visit said aloud is well under a
// minute; three minutes of speech is also about what the fill accepts at once.
export const CLIP_MAX_MS = 3 * 60 * 1000;

/**
 * Voice dictation, extracted from CommunicationsPageV2 so the completion
 * notes box (and any other field) can reuse it.
 *
 * Usage:
 *   const { listening, supported, toggle } = useSpeechDictation((text) =>
 *     setNotes((b) => (b ? `${b} ${text}` : text)));
 *
 * `onTranscript(text)` fires with each FINAL transcript chunk (trimmed); the
 * caller decides how to append. Falls back to an alert on browsers without
 * support (Firefox); iOS Safari ships `webkitSpeechRecognition`.
 *
 * Keep-listening (SPEECH path only): the browser ends a recognition session
 * on its own after a pause, so `onend` restarts the same instance and
 * `listening` stays true, UNLESS one of these holds, in which case the
 * session finishes (`listening` false, the ref cleared) instead:
 *   - the tech tapped stop (second tap calls `stop()`)
 *   - the hook unmounted (existing abort + handler nulling)
 *   - a recognition error fired other than `no-speech` (`aborted` included)
 *   - no FINAL transcript for IDLE_STOP_MS since the session started or the
 *     last final result (a timer stops the live session; onend re-checks)
 *   - the page is hidden (`document.visibilityState === "hidden"`; a
 *     visibilitychange listener stops the live session; onend re-checks)
 *   - the user clicks any button or link, submits a form, or presses a key
 *     (Save, Send, Generate, Complete read the field on that action)
 *   - 3 consecutive sessions each ended under 1000ms after their own
 *     `start()` with no final result (a fast-end loop, e.g. mic denied by OS)
 *   - `recognitionRef.current` no longer points at this instance
 * If the restart `start()` itself throws, the session also finishes normally.
 *
 * Upload fallback (GATE_TECH_DICTATION_UPLOAD): pass
 * `{ uploadServiceId }` and, ONLY where SpeechRecognition is missing, the
 * hook asks `/tech/services/:id/dictation/availability`; when the server says
 * yes, the mic records with MediaRecorder and the clip is POSTed for server
 * transcription — one transcript per tap-to-stop, appended through the same
 * `onTranscript`. `mode` is "speech" | "upload" | null; `starting` is true
 * from the tap until the microphone opens or is refused (a permission prompt
 * can hold it open); `uploading` is true while a clip is in flight. Browsers
 * with SpeechRecognition never change behavior.
 *
 * Clip mode: pass `{ clipHandler }` (async (blob, durationSeconds) => void) and
 * the mic ALWAYS records, on every browser that can record, and hands the
 * finished clip to the handler instead of transcribing it here: no speech
 * recognition, no availability request, no transcript callback. `uploading` is
 * true while the handler runs. (Fast Complete voice fill: owner ruling
 * 2026-10-03, "always our transcriber".)
 */
export default function useSpeechDictation(onTranscript, options = {}) {
  const uploadServiceId = options.uploadServiceId ?? null;
  const clipMode = typeof options.clipHandler === "function";
  const clipMaxMs = Number(options.clipMaxMs) > 0 ? Number(options.clipMaxMs) : CLIP_MAX_MS;
  const clipHandlerRef = useRef(options.clipHandler);
  clipHandlerRef.current = options.clipHandler;
  const [listening, setListening] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadAvailable, setUploadAvailable] = useState(false);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  // Removes the clip's hidden-page guard (set while a clip records).
  const unguardRef = useRef(null);
  // True from the first tap until getUserMedia settles: a second tap in that
  // window must not open a second stream nobody can stop. The ref answers
  // that tap synchronously; `starting` shows the same window to the caller.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  // Current dictation target; a transcript that arrives for a previous
  // target is dropped (the panel can move to another visit mid-upload).
  const serviceIdRef = useRef(uploadServiceId);
  serviceIdRef.current = uploadServiceId;
  // Keep the latest callback without re-creating `toggle` each render.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // SPEECH path keep-listening state (see the hook's doc comment for the
  // stop conditions these back). All reset at the start of a fresh toggle().
  const stopRequestedRef = useRef(false); // set by the second (stop) tap
  const fatalErrorRef = useRef(false); // set by onerror, except for no-speech
  const lastFinalAtRef = useRef(0); // session start, bumped by each final result
  const sessionStartedAtRef = useRef(0); // this internal session's start() time
  const fastEndStreakRef = useRef(0); // consecutive fast, empty sessions
  const gotResultThisSessionRef = useRef(false); // final result in this session
  // Ends a session that stays open with no final result for IDLE_STOP_MS —
  // a browser that honors `continuous` may never fire onend on its own.
  const idleTimerRef = useRef(null);
  // The element whose click started the live session: its own press is the
  // normal tap-to-stop, never an "other button" stop that could let one
  // gesture both stop and restart it.
  const micElRef = useRef(null);
  // Set by a stop the user did NOT make on the mic (another button, a form
  // submit, a disabled mic): that action already read the field, so a final
  // result still in flight is dropped instead of landing after it.
  const discardResultsRef = useRef(false);

  const speechSupported =
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function" &&
    !!navigator.mediaDevices?.getUserMedia;

  // Upload availability is only worth asking about where speech recognition
  // is missing — the gate never changes a SpeechRecognition browser.
  useEffect(() => {
    if (clipMode || speechSupported || !recorderSupported || !uploadServiceId) {
      setUploadAvailable(false);
      return undefined;
    }
    let disposed = false;
    const token = localStorage.getItem("waves_admin_token");
    if (!token) return undefined;
    fetch(
      `${API_BASE}/tech/services/${encodeURIComponent(uploadServiceId)}/dictation/availability`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => {
        if (!disposed) setUploadAvailable(d?.available === true);
      })
      .catch(() => {
        if (!disposed) setUploadAvailable(false);
      });
    return () => {
      disposed = true;
    };
  }, [clipMode, speechSupported, recorderSupported, uploadServiceId]);

  const clipOrSpeech = clipMode ? (recorderSupported ? "upload" : null) : "speech";
  const mode = clipMode || speechSupported ? clipOrSpeech : uploadAvailable ? "upload" : null;
  const supported = mode !== null;

  const uploadClip = useCallback(
    async (blob, durationSeconds) => {
      if (clipHandlerRef.current) {
        if (!blob || !blob.size) return;
        setUploading(true);
        try {
          await clipHandlerRef.current(blob, durationSeconds);
        } finally {
          if (mountedRef.current) setUploading(false);
        }
        return;
      }
      const token = localStorage.getItem("waves_admin_token");
      if (!token || !blob || !blob.size) return;
      setUploading(true);
      try {
        const form = new FormData();
        const type = (blob.type || "audio/webm").split(";")[0];
        const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm";
        form.append("audio", blob, `dictation.${ext}`);
        // Recorded seconds feed the server's transcript plausibility guard.
        if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
          form.append("duration_seconds", String(Math.round(durationSeconds)));
        }
        const r = await fetch(
          `${API_BASE}/tech/services/${encodeURIComponent(uploadServiceId)}/dictation`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || `Transcription failed (HTTP ${r.status})`);
        const text = String(data?.text || "").trim();
        // The round trip can outlive the field: unmounted, or the panel now
        // dictates for a different visit. Never append into the wrong notes.
        if (!mountedRef.current || serviceIdRef.current !== uploadServiceId) return;
        if (text && onTranscriptRef.current) onTranscriptRef.current(text);
      } catch (e) {
        if (mountedRef.current) alert(`Dictation error: ${e.message}`);
      } finally {
        if (mountedRef.current) setUploading(false);
      }
    },
    [uploadServiceId],
  );

  const toggleUpload = useCallback(async () => {
    // Second tap stops the recording; the clip uploads on stop.
    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
      return;
    }
    if (uploading || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const doneStarting = () => {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      doneStarting();
      alert(`Microphone unavailable: ${e?.message || e}`);
      return;
    }
    if (!mountedRef.current) {
      // Unmounted while the permission prompt was open — release the mic.
      stream.getTracks().forEach((t) => t.stop());
      doneStarting();
      return;
    }
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = preferred.find(
      (t) => typeof window.MediaRecorder.isTypeSupported === "function" && window.MediaRecorder.isTypeSupported(t),
    );
    let rec;
    try {
      rec = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      // Recorder construction can throw (unsupported options, device gone):
      // release the live mic and let the tech type.
      stream.getTracks().forEach((t) => t.stop());
      doneStarting();
      alert(`Dictation error: ${e?.message || "recorder unavailable"}`);
      return;
    }
    // Clip mode: a recording never runs behind a hidden or closing page (a
    // locked phone, another tab), where it would capture whatever is said next.
    // The guard is attached here, in the same synchronous step as the hidden
    // check and rec.start(), so no visibility change can fall between them;
    // it comes off when the recorder stops. Stopping hands over what was recorded.
    const stopRecording = () => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* already stopped */
      }
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") stopRecording();
    };
    const guarded = clipMode && typeof document !== "undefined";
    let cutoffTimer = null;
    const unguard = () => {
      if (!guarded) return;
      clearTimeout(cutoffTimer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", stopRecording);
      unguardRef.current = null;
    };
    if (guarded) {
      if (document.visibilityState === "hidden") {
        // Hidden while the permission prompt was open: the clip never starts.
        stream.getTracks().forEach((t) => t.stop());
        doneStarting();
        return;
      }
      document.addEventListener("visibilitychange", onHidden);
      window.addEventListener("pagehide", stopRecording);
      // A forgotten mic on a visible page (a phone on a mount) ends by itself:
      // the clip stops at the cutoff and what was recorded is handed over.
      cutoffTimer = setTimeout(stopRecording, clipMaxMs);
      unguardRef.current = unguard;
    }
    const chunks = [];
    const startedAt = Date.now();
    // onerror is followed by onstop in the MediaRecorder state machine — a
    // failed recording must not upload its partial chunks as if it were whole.
    let recordingFailed = false;
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = () => {
      unguard();
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setListening(false);
      if (recordingFailed) return;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      uploadClip(blob, (Date.now() - startedAt) / 1000);
    };
    rec.onerror = () => {
      recordingFailed = true;
      unguard();
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setListening(false);
      alert("Dictation error: recording failed");
    };
    try {
      rec.start();
    } catch (e) {
      // start() can throw synchronously (state / device errors): release the
      // mic and reset so the next tap starts clean.
      unguard();
      stream.getTracks().forEach((t) => t.stop());
      doneStarting();
      alert(`Dictation error: ${e?.message || "could not start recording"}`);
      return;
    }
    recorderRef.current = rec;
    // Both updates land in one render, so a caller watching
    // `starting || listening` never sees a gap between them.
    doneStarting();
    setListening(true);
  }, [uploadClip, uploading, clipMode, clipMaxMs]);

  const toggle = useCallback((event) => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    if (mode === "upload") {
      toggleUpload();
      return;
    }
    if (!SR) {
      alert(
        "Voice dictation isn't supported in this browser. Use the keyboard mic on your phone, or try Chrome/Safari.",
      );
      return;
    }
    // Second tap stops an in-progress session; onend sees stopRequestedRef
    // and finishes instead of restarting.
    if (recognitionRef.current) {
      stopRequestedRef.current = true;
      recognitionRef.current.stop();
      return;
    }
    const rec = new SR();
    // Idle cutoff as a real timer, not only an onend check: stop() ends the
    // session through onend, which sees stopRequestedRef and finishes.
    const armIdleTimer = () => {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        if (recognitionRef.current !== rec) return;
        stopRequestedRef.current = true;
        try {
          rec.stop();
        } catch {
          /* already ending */
        }
      }, IDLE_STOP_MS);
    };
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (ev) => {
      if (discardResultsRef.current) return;
      let append = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) append += ev.results[i][0].transcript;
      }
      const text = append.trim();
      if (text) {
        gotResultThisSessionRef.current = true;
        lastFinalAtRef.current = Date.now();
        armIdleTimer();
        if (onTranscriptRef.current) onTranscriptRef.current(text);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        fatalErrorRef.current = true;
        alert(
          "Microphone access is blocked. Allow mic permission for this site, or use the keyboard mic on your phone.",
        );
      } else if (e.error === "no-speech") {
        // Not fatal — onend below still restarts unless another condition applies.
      } else {
        // Includes "aborted": ends the session, but (like the prior behavior)
        // never alerts for it.
        fatalErrorRef.current = true;
        if (e.error !== "aborted") alert(`Dictation error: ${e.error}`);
      }
    };
    rec.onend = () => {
      const now = Date.now();
      const sessionDurationMs = now - sessionStartedAtRef.current;
      const isFastEmptySession = sessionDurationMs < 1000 && !gotResultThisSessionRef.current;
      fastEndStreakRef.current = isFastEmptySession ? fastEndStreakRef.current + 1 : 0;

      const pageHidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      const idleTooLong = now - lastFinalAtRef.current >= IDLE_STOP_MS;
      const shouldStop =
        stopRequestedRef.current ||
        fatalErrorRef.current ||
        recognitionRef.current !== rec ||
        pageHidden ||
        idleTooLong ||
        fastEndStreakRef.current >= 3;

      if (shouldStop) {
        clearTimeout(idleTimerRef.current);
        setListening(false);
        recognitionRef.current = null;
        return;
      }

      try {
        sessionStartedAtRef.current = Date.now();
        gotResultThisSessionRef.current = false;
        rec.start();
      } catch {
        clearTimeout(idleTimerRef.current);
        setListening(false);
        recognitionRef.current = null;
      }
    };
    stopRequestedRef.current = false;
    discardResultsRef.current = false;
    micElRef.current = event?.currentTarget instanceof Element ? event.currentTarget : null;
    fatalErrorRef.current = false;
    fastEndStreakRef.current = 0;
    gotResultThisSessionRef.current = false;
    lastFinalAtRef.current = Date.now();
    sessionStartedAtRef.current = Date.now();
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      // start() can throw synchronously (state / device errors). Never keep
      // a session that never started: the next tap would only stop() it.
      recognitionRef.current = null;
      alert(`Dictation error: ${e?.message || "could not start dictation"}`);
      return;
    }
    armIdleTimer();
    setListening(true);
  }, [mode, toggleUpload]);

  // A live speech session ends the moment the user moves on, the way a pause
  // used to end it before keep-listening:
  //   - leaving the page (a browser that keeps a continuous session open
  //     would otherwise record in the background);
  //   - clicking any button or link, submitting a form, or pressing a key
  //     (below). Save, Send,
  //     Generate and Complete read the dictated field on that press, so
  //     speech after it — and a final result still in flight — must not land
  //     in state the action already took. The mic that started the session
  //     is excluded: its press is the normal tap-to-stop, which still
  //     delivers the last words. Another mic's press starts that field.
  // The MediaRecorder upload path records until tap-to-stop and is unaffected.
  useEffect(() => {
    if (!listening || typeof document === "undefined") return undefined;
    const stopLive = ({ discard = false } = {}) => {
      const rec = recognitionRef.current;
      if (!rec) return;
      stopRequestedRef.current = true;
      if (discard) discardResultsRef.current = true;
      try {
        rec.stop();
      } catch {
        /* already ending */
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopLive();
    };
    // Capture-phase click: fires for pointer AND keyboard (Enter / Space)
    // activation, and on the document before the button's own handler runs.
    const onClick = (event) => {
      const el = event.target instanceof Element ? event.target : null;
      if (!el || micElRef.current?.contains(el)) return;
      if (el.closest('button, [role="button"], input[type="submit"], input[type="button"], a[href]')) {
        stopLive({ discard: true });
      }
    };
    const onSubmit = () => stopLive({ discard: true });
    // Touching the keyboard ends it too: Enter in a prompt box can run the
    // action straight from onKeyDown (charts Generate, the command bar) with
    // no click or submit. A bare modifier key is not a keystroke.
    const onKeyDown = (event) => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      const el = event.target instanceof Element ? event.target : null;
      if (el && micElRef.current?.contains(el)) return;
      stopLive({ discard: true });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [listening]);

  // Stop an in-progress session if the consumer unmounts (e.g. the completion
  // modal closes mid-dictation) so the mic isn't left recording and stale
  // callbacks can't fire against an unmounted notes setter.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(idleTimerRef.current);
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          /* no-op */
        }
        recognitionRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder) {
        // Abandon, don't upload: the field is gone.
        unguardRef.current?.();
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          recorder.stream?.getTracks?.().forEach((t) => t.stop());
          recorder.stop();
        } catch {
          /* no-op */
        }
        recorderRef.current = null;
      }
    };
  }, []);

  // Ends a live SPEECH session for a consumer that has gone busy (e.g. a
  // disabled mic while its field is being rewritten) and drops any result
  // still in flight. The MediaRecorder upload path records until
  // tap-to-stop and has no in-flight speech results to drop.
  const cancel = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    stopRequestedRef.current = true;
    discardResultsRef.current = true;
    try {
      rec.stop();
    } catch {
      /* already ending */
    }
  }, []);

  return { listening, supported, toggle, cancel, mode, starting, uploading };
}
