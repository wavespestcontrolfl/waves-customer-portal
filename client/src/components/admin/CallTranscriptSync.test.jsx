// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CallTranscriptSync, {
  activeSegmentIndex,
  formatClock,
  parseTranscriptSegments,
  segmentsMatchTranscript,
} from "./CallTranscriptSync";

const STRUCTURED = {
  provider: "openai",
  model: "gpt-4o-transcribe-diarize",
  segments: [
    { id: "seg_001", index: 0, speaker: "A", start_ms: 0, end_ms: 3200, text: "Thanks for calling Waves." },
    { id: "seg_002", index: 1, speaker: "B", start_ms: 3400, end_ms: 9000, text: "Hi, I need a WDO inspection." },
    { id: "seg_003", index: 2, speaker: "A", start_ms: 9200, end_ms: 12000, text: "Sure, when is closing?" },
  ],
};

afterEach(cleanup);

describe("parseTranscriptSegments", () => {
  it("accepts the persisted jsonb object or its string form and drops junk", () => {
    const fromObject = parseTranscriptSegments(STRUCTURED);
    const fromString = parseTranscriptSegments(JSON.stringify(STRUCTURED));
    expect(fromObject).toHaveLength(3);
    expect(fromString).toEqual(fromObject);
    expect(fromObject[1]).toEqual({
      id: "seg_002", speaker: "B", startMs: 3400, endMs: 9000, text: "Hi, I need a WDO inspection.",
    });

    expect(parseTranscriptSegments(null)).toEqual([]);
    expect(parseTranscriptSegments("not json")).toEqual([]);
    expect(parseTranscriptSegments({ segments: [{ text: "   ", start_ms: 1 }, { text: "no time" }] })).toEqual([]);
    // normalizeOpenAISegments persists start_ms: null for an untimed segment —
    // Number(null) is 0, so it must be rejected before coercion.
    expect(parseTranscriptSegments({ segments: [{ id: "u", text: "untimed", start_ms: null, end_ms: null }, { id: "e", text: "empty", start_ms: "" }] })).toEqual([]);
  });

  it("sorts by start and keeps the last spoken line lit through silence", () => {
    const segs = parseTranscriptSegments({
      segments: [
        { id: "b", start_ms: 5000, end_ms: 6000, text: "second" },
        { id: "a", start_ms: 0, end_ms: 1000, text: "first" },
      ],
    });
    expect(segs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(activeSegmentIndex(segs, -1)).toBe(-1);
    expect(activeSegmentIndex(segs, 0)).toBe(0);
    expect(activeSegmentIndex(segs, 3000)).toBe(0);
    expect(activeSegmentIndex(segs, 5000)).toBe(1);
    expect(activeSegmentIndex(segs, 99999)).toBe(1);
    expect(activeSegmentIndex([], 10)).toBe(-1);
  });

  it("only trusts segments that still read as the flat transcript", () => {
    const segs = parseTranscriptSegments(STRUCTURED);
    const flat = "Agent: Thanks for calling Waves.\nCaller: Hi, I need a WDO inspection.\nAgent: Sure, when is closing?";
    expect(segmentsMatchTranscript(segs, flat)).toBe(true);
    // Text-only reprocess rewrote the transcript; the old blob is stale.
    expect(segmentsMatchTranscript(segs, "Agent: Waves Pest Control.\nCaller: I want to cancel my lawn plan.\nAgent: Let me pull that up.")).toBe(false);
    expect(segmentsMatchTranscript(segs, "")).toBe(false);
    expect(segmentsMatchTranscript([], flat)).toBe(false);
  });

  it("formats clock offsets", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65400)).toBe("1:05");
  });
});

describe("CallTranscriptSync", () => {
  it("highlights the line under the playhead and seeks on click", () => {
    const onSeek = vi.fn();
    const { rerender } = render(
      <CallTranscriptSync segments={STRUCTURED} currentMs={4000} onSeek={onSeek} />,
    );

    const items = screen.getAllByRole("button");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("aria-current", "true");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveTextContent("0:03");
    expect(items[1]).toHaveTextContent("Speaker B:");

    fireEvent.click(items[2]);
    expect(onSeek).toHaveBeenCalledWith(9200);

    rerender(<CallTranscriptSync segments={STRUCTURED} currentMs={-1} onSeek={onSeek} />);
    expect(screen.queryAllByRole("button").some((b) => b.hasAttribute("aria-current"))).toBe(false);
  });

  it("renders nothing without segments", () => {
    const { container } = render(<CallTranscriptSync segments={{ segments: [] }} currentMs={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
