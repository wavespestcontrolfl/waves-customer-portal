import { useEffect, useId } from "react";
import { Button } from "../ui";
import useSpeechDictation from "../../hooks/useSpeechDictation";
import { setDictationPending } from "../../hooks/dictationPending";

/**
 * DictationButton — small mic that transcribes speech to text.
 *
 * Tap to start, tap to stop. Each transcript chunk is passed to
 * `onAppend(text)`; the caller decides how to merge it into the field value.
 * Mirrors the dictation pattern used on CommunicationsPageV2. Renders nothing
 * on browsers without SpeechRecognition support (e.g. Firefox) so field layout
 * stays clean — on those, techs can fall back to the phone keyboard mic.
 * With GATE_SERVER_DICTATION on, the mic records a clip and our server hears it
 * (words arrive after the tap that stops it, with "Transcribing" showing); off,
 * it is the browser's speech recognition. While a clip is recorded or
 * transcribed the button reports it to `useDictationPending()` so Send / Ask
 * buttons can wait for the words.
 *
 * Props:
 *   onAppend(text)  required — called with each final transcript chunk
 *   palette         optional — { accent, muted, red, card } for theming
 *   title           optional — accessible label / tooltip (default "Dictate")
 *   size            optional — button diameter in px (default 30)
 *   dictationContext optional — { customerId, serviceId } of the record the field
 *                   belongs to; server dictation spells that customer's name
 *                   right (ids only, never words)
 *   uploadServiceId optional — the visit's id; where SpeechRecognition is
 *                   missing, the hook records a clip and sends it for server
 *                   transcription instead (GATE_TECH_DICTATION_UPLOAD)
 *   clipHandler     optional — async (blob, seconds): the mic always records and
 *                   hands the clip here (the caller sends it to its own
 *                   transcriber and appends the words), never the browser's
 *                   speech recognition
 *   onPendingChange optional — told true from the mic tap until a recorded
 *                   clip is taken and transcribed (the upload path only),
 *                   so the caller can hold a save until the words arrive
 */
function micLabel({ uploading, listening, title }) {
  if (uploading) return "Transcribing";
  return listening ? "Stop dictation" : title;
}

function legacyMicStyle({ size, listening, palette }) {
  const {
    accent = "#0ea5e9",
    muted = "#94a3b8",
    red = "#ef4444",
    card = "#ffffff",
  } = palette || {};
  return {
    width: size,
    height: size,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    border: `1px solid ${listening ? red : muted}`,
    background: listening ? red : card,
    color: listening ? "#fff" : accent,
    cursor: "pointer",
    padding: 0,
    boxShadow: listening ? `0 0 0 4px ${red}33` : "none",
    transition: "background 0.15s, box-shadow 0.15s",
    flex: "0 0 auto",
  };
}

export default function DictationButton({
  onAppend,
  palette,
  title = "Dictate",
  size = 30,
  presentation = "legacy",
  disabled = false,
  uploadServiceId,
  dictationContext,
  clipHandler,
  onPendingChange,
}) {
  const migrated = presentation === "admin";
  const Control = migrated ? Button : "button";
  const { listening, supported, toggle, cancel, mode, starting, uploading } = useSpeechDictation(onAppend, { uploadServiceId, clipHandler, dictationContext });

  // A recorded clip has no transcript until it is stopped and transcribed;
  // a save in that window would go out without it. The window opens at the
  // tap: while the phone is still asking for the mic, a save would miss the
  // clip and anything opened over the sheet would sit on a live recording.
  // (Live speech recognition stops itself when another button is pressed,
  // so it never holds a save.)
  const pending = mode === "upload" && (starting || listening || uploading);
  // Unmounting abandons a clip still in flight (the hook stops the recorder
  // and drops a late transcript), so nothing is pending once the mic is gone.
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  // The same window, for any Send / Ask button on the page (dictationPending.js).
  const pendingId = useId();
  useEffect(() => {
    setDictationPending(pendingId, pending);
    return () => setDictationPending(pendingId, false);
  }, [pending, pendingId]);

  // A consumer disables the mic while it is busy (e.g. an AI rewrite of the
  // same field). Dictation keeps listening through pauses, and a disabled
  // button can't be tapped to stop it, so disabling it ends the session and
  // drops a result still in flight.
  useEffect(() => {
    if (disabled && listening) cancel();
  }, [disabled, listening, cancel]);

  if (!supported) return null;

  const label = micLabel({ uploading, listening, title });

  return (
    <Control
      type="button"
      onClick={toggle}
      disabled={disabled || uploading}
      aria-busy={uploading || undefined}
      title={label}
      aria-label={label}
      aria-pressed={listening}
      variant={migrated ? (listening ? "danger" : "secondary") : undefined}
      className={migrated ? "min-w-11 !p-0" : undefined}
      style={migrated ? undefined : legacyMicStyle({ size, listening, palette })}
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
    </Control>
  );
}
