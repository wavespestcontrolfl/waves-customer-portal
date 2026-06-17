import { useCallback, useRef, useState } from "react";

/**
 * Web Speech API voice dictation, extracted from CommunicationsPageV2 so the
 * completion notes box (and any other field) can reuse it.
 *
 * Usage:
 *   const { listening, supported, toggle } = useSpeechDictation((text) =>
 *     setNotes((b) => (b ? `${b} ${text}` : text)));
 *
 * `onTranscript(text)` fires with each FINAL transcript chunk (trimmed); the
 * caller decides how to append. Continuous capture toggles off on a second
 * tap. Falls back to an alert on browsers without support (Firefox); iOS
 * Safari ships `webkitSpeechRecognition`.
 */
export default function useSpeechDictation(onTranscript) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  // Keep the latest callback without re-creating `toggle` each render.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const supported =
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggle = useCallback(() => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    if (!SR) {
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
  }, []);

  return { listening, supported, toggle };
}
