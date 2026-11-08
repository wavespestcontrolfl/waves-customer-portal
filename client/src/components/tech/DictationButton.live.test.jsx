// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DictationButton from "./DictationButton";

// GATE_DICTATION_LIVE_WORDS: the bubble beside the mic. The hook is faked; useSpeechDictation.live.test.js covers it.
let hookState;
vi.mock("../../hooks/useSpeechDictation", () => ({ default: () => hookState }));

const base = { listening: true, supported: true, toggle: vi.fn(), cancel: vi.fn(), mode: "upload", starting: false, uploading: false };

afterEach(cleanup);

describe("DictationButton live words bubble", () => {
  it("shows the words so far beside the mic, muted, without changing the mic", () => {
    hookState = { ...base, liveText: "Treated the lanai for ghost ants" };
    render(<DictationButton onAppend={vi.fn()} presentation="admin" />);
    const bubble = screen.getByTestId("dictation-live-words");
    expect(bubble).toHaveTextContent("Treated the lanai for ghost ants");
    expect(bubble).toHaveAttribute("aria-live", "off");
    expect(bubble.className).toMatch(/text-zinc-600/);
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
  });

  it("is two lines of 14px text at most, and a long dictation keeps its newest words", () => {
    hookState = { ...base, liveText: `${"older words ".repeat(40)}newest words here` };
    render(<DictationButton onAppend={vi.fn()} />);
    const bubble = screen.getByTestId("dictation-live-words");
    expect(bubble).toHaveStyle({ fontSize: "14px", overflow: "hidden", height: "48px" });
    expect(bubble.textContent.length).toBeLessThanOrEqual(162);
    expect(bubble.textContent.endsWith("newest words here")).toBe(true);
    expect(bubble.textContent.startsWith("…")).toBe(true);
  });

  it("is absent with no live words, so the mic renders exactly as before", () => {
    hookState = { ...base, liveText: "" };
    const { container } = render(<DictationButton onAppend={vi.fn()} />);
    expect(screen.queryByTestId("dictation-live-words")).toBeNull();
    expect(container.children).toHaveLength(1);
  });
});
