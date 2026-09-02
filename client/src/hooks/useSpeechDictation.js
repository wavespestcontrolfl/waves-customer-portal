import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * Voice dictation, extracted from CommunicationsPageV2 so the completion
 * notes box (and any other field) can reuse it.
 *
 * Usage:
 *   const { listening, supported, toggle } = useSpeechDictation((text) =>
 *     setNotes((b) => (b ? `${b} ${text}` : text)));
 *
 * `onTranscript(text)` fires with each FINAL transcript chunk (trimmed); the
 * caller decides how to append. Continuous capture toggles off on a second
 * tap. Falls back to an alert on browsers without support (Firefox); iOS
 * Safari ships `webkitSpeechRecognition`.
 *
 * Upload fallback (GATE_TECH_DICTATION_UPLOAD): pass
 * `{ uploadServiceId }` and, ONLY where SpeechRecognition is missing, the
 * hook asks `/tech/services/:id/dictation/availability`; when the server says
 * yes, the mic records with MediaRecorder and the clip is POSTed for server
 * transcription — one transcript per tap-to-stop, appended through the same
 * `onTranscript`. `mode` is "speech" | "upload" | null; `uploading` is true
 * while a clip is in flight. Browsers with SpeechRecognition never change
 * behavior.
 */
export default function useSpeechDictation(onTranscript, options = {}) {
  const uploadServiceId = options.uploadServiceId ?? null;
  const [listening, setListening] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadAvailable, setUploadAvailable] = useState(false);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  // True from the first tap until getUserMedia settles: a second tap in that
  // window must not open a second stream nobody can stop.
  const startingRef = useRef(false);
  // Keep the latest callback without re-creating `toggle` each render.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

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
    if (speechSupported || !recorderSupported || !uploadServiceId) {
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
  }, [speechSupported, recorderSupported, uploadServiceId]);

  const mode = speechSupported ? "speech" : uploadAvailable ? "upload" : null;
  const supported = mode !== null;

  const uploadClip = useCallback(
    async (blob, durationSeconds) => {
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
        if (text && onTranscriptRef.current) onTranscriptRef.current(text);
      } catch (e) {
        alert(`Dictation error: ${e.message}`);
      } finally {
        setUploading(false);
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
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      startingRef.current = false;
      alert(`Microphone unavailable: ${e?.message || e}`);
      return;
    }
    if (!mountedRef.current) {
      // Unmounted while the permission prompt was open — release the mic.
      stream.getTracks().forEach((t) => t.stop());
      startingRef.current = false;
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
      startingRef.current = false;
      alert(`Dictation error: ${e?.message || "recorder unavailable"}`);
      return;
    }
    const chunks = [];
    const startedAt = Date.now();
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setListening(false);
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      uploadClip(blob, (Date.now() - startedAt) / 1000);
    };
    rec.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setListening(false);
      alert("Dictation error: recording failed");
    };
    recorderRef.current = rec;
    rec.start();
    startingRef.current = false;
    setListening(true);
  }, [uploadClip, uploading]);

  const toggle = useCallback(() => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    if (!SR) {
      if (mode === "upload") {
        toggleUpload();
        return;
      }
      alert(
        "Voice dictation isn't supported in this browser. Use the keyboard mic on your phone, or try Chrome/Safari.",
      );
      return;
    }
    // Second tap stops an in-progress session.
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (ev) => {
      let append = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) append += ev.results[i][0].transcript;
      }
      const text = append.trim();
      if (text && onTranscriptRef.current) onTranscriptRef.current(text);
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") {
        alert(`Dictation error: ${e.error}`);
      }
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [mode, toggleUpload]);

  // Stop an in-progress session if the consumer unmounts (e.g. the completion
  // modal closes mid-dictation) so the mic isn't left recording and stale
  // callbacks can't fire against an unmounted notes setter.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  return { listening, supported, toggle, mode, uploading };
}
