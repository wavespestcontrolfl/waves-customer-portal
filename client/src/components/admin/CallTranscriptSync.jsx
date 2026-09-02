import React, { useEffect, useMemo, useRef } from "react";
import { cn } from "../ui";

/**
 * Audio-synced call transcript (admin call log, Tier 1 zinc).
 *
 * Renders the diarized `call_log.transcript_structured.segments` as a list
 * of clickable lines. The line whose [start_ms, end_ms) contains the
 * player's current position is highlighted and scrolled into view; clicking
 * any line calls `onSeek(ms)`. The parent owns the audio element — this
 * component never plays audio itself.
 *
 * Speaker labels: the diarizer stores raw labels (`A`/`B`/`speaker_0`), not
 * the Agent/Caller labels of the flat transcript, so lines are labeled
 * "Speaker A" etc. Honest over clever.
 */

export function parseTranscriptSegments(structured) {
  let value = structured;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const segments = Array.isArray(value?.segments) ? value.segments : [];
  return segments
    .filter(
      (s) =>
        s &&
        typeof s.text === "string" &&
        s.text.trim() &&
        // normalizeOpenAISegments persists start_ms: null when the provider
        // omitted the timestamp; Number(null) is 0, so guard before coercing
        // or an untimed line renders as a clickable 0:00.
        s.start_ms !== null &&
        s.start_ms !== undefined &&
        s.start_ms !== "" &&
        Number.isFinite(Number(s.start_ms)),
    )
    .map((s, i) => ({
      id: s.id != null ? String(s.id) : `seg_${i}`,
      speaker: s.speaker != null ? String(s.speaker) : "",
      startMs: Math.max(0, Number(s.start_ms)),
      endMs: Number.isFinite(Number(s.end_ms))
        ? Number(s.end_ms)
        : Number(s.start_ms),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

export function activeSegmentIndex(segments, currentMs) {
  if (!Number.isFinite(currentMs) || !segments.length) return -1;
  let active = -1;
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].startMs <= currentMs) active = i;
    else break;
  }
  if (active === -1) return -1;
  const seg = segments[active];
  // A gap between segments (silence) keeps the last spoken line lit rather
  // than flickering to nothing; only a position before the first line is
  // "no active segment".
  return currentMs >= seg.startMs ? active : -1;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function speakerLabel(raw) {
  if (!raw) return "";
  const m = /^(?:speaker[_ -]?)?([a-z0-9]+)$/i.exec(raw.trim());
  const key = m ? m[1].toUpperCase() : raw;
  return `Speaker ${key}`;
}

export default function CallTranscriptSync({
  segments,
  currentMs,
  onSeek,
  className,
}) {
  const list = useMemo(
    () => (Array.isArray(segments) ? segments : parseTranscriptSegments(segments)),
    [segments],
  );
  const active = activeSegmentIndex(list, currentMs);
  const activeRef = useRef(null);

  useEffect(() => {
    const el = activeRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!list.length) return null;

  return (
    <ol
      className={cn(
        "m-0 p-0 list-none max-h-72 overflow-y-auto",
        className,
      )}
      aria-label="Transcript, click a line to seek the recording there"
    >
      {list.map((seg, i) => {
        const isActive = i === active;
        return (
          <li key={seg.id} ref={isActive ? activeRef : undefined}>
            <button
              type="button"
              onClick={() => onSeek?.(seg.startMs)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "w-full text-left flex flex-col md:flex-row md:items-start gap-0.5 md:gap-2",
                "px-2 py-1.5 md:py-1 rounded-md border-0 u-focus-ring",
                "text-14 md:text-12 leading-relaxed",
                isActive
                  ? "bg-zinc-200 text-ink-primary"
                  : "bg-transparent text-ink-secondary hover:bg-zinc-100",
              )}
            >
              <span className="shrink-0 flex gap-2 text-ink-tertiary">
                <span className="tabular-nums w-10">{formatClock(seg.startMs)}</span>
                {seg.speaker ? (
                  <span className="font-medium">{speakerLabel(seg.speaker)}:</span>
                ) : null}
              </span>
              <span>{seg.text}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
