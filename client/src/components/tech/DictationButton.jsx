import { useEffect, useRef, useState } from 'react';

/**
 * DictationButton — small Web Speech API mic that transcribes speech to text.
 *
 * Tap to start, tap to stop. Each final transcript chunk is passed to
 * `onAppend(text)`; the caller decides how to merge it into the field value.
 * Mirrors the dictation pattern used on CommunicationsPageV2. Renders nothing
 * on browsers without SpeechRecognition support (e.g. Firefox) so field layout
 * stays clean — on those, techs can fall back to the phone keyboard mic.
 *
 * Props:
 *   onAppend(text)  required — called with each final transcript chunk
 *   palette         optional — { accent, muted, red, card } for theming
 *   title           optional — accessible label / tooltip (default "Dictate")
 *   size            optional — button diameter in px (default 30)
 */
export default function DictationButton({ onAppend, palette, title = 'Dictate', size = 30 }) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef(null);
  const onAppendRef = useRef(onAppend);
  onAppendRef.current = onAppend;

  useEffect(() => {
    const SR = typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;
    setSupported(!!SR);
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    };
  }, []);

  const toggle = () => {
    const SR = typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;
    if (!SR) return;
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (ev) => {
      let append = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) append += ev.results[i][0].transcript;
      }
      if (append.trim()) onAppendRef.current?.(append.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        alert('Microphone access is blocked. Allow mic permission for this site, or use the keyboard mic on your phone.');
      }
      setListening(false);
    };
    rec.onend = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* start can throw if already running */ }
  };

  if (!supported) return null;

  const P = palette || {};
  const accent = P.accent || '#0ea5e9';
  const muted = P.muted || '#94a3b8';
  const red = P.red || '#ef4444';
  const card = P.card || '#ffffff';

  return (
    <button
      type="button"
      onClick={toggle}
      title={listening ? 'Stop dictation' : title}
      aria-label={listening ? 'Stop dictation' : title}
      aria-pressed={listening}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        border: `1px solid ${listening ? red : muted}`,
        background: listening ? red : card,
        color: listening ? '#fff' : accent,
        cursor: 'pointer',
        padding: 0,
        boxShadow: listening ? `0 0 0 4px ${red}33` : 'none',
        transition: 'background 0.15s, box-shadow 0.15s',
        flex: '0 0 auto',
      }}
    >
      <svg
        width={Math.round(size * 0.52)}
        height={Math.round(size * 0.52)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
  );
}
