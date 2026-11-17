// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import CallLogTabV2, { awaitingSummary, callSummaryFor, SUMMARY_POLL_MS } from "./CallLogTabV2";

// GATE_CALL_EARLY_SUMMARY: a call row shows the summary Claude wrote from the live text the moment the call
// ended, then the recording pipeline's own summary once it lands. A call with no live-text summary is unchanged.
const EARLY = "The caller has ants again; a free return visit is set for Thursday at 9.";
const FINAL = "Customer reported ants in the kitchen; return visit booked for Thursday 9 AM.";
const withEarly = (extra = {}) => ({
  metadata: { live_transcription: { early_summary: { text: EARLY, at: "2026-11-17T15:01:00.000Z" } } },
  ...extra,
});

describe("callSummaryFor", () => {
  it("shows nothing for a call with no live-text summary, even when the pipeline wrote one", () => {
    expect(callSummaryFor({ call_summary: FINAL })).toBeNull();
    expect(callSummaryFor({ metadata: { live_transcription: { live_at: "x" } } })).toBeNull();
    expect(callSummaryFor(null)).toBeNull();
  });

  it("shows the live-text summary until the pipeline's summary lands", () => {
    expect(callSummaryFor(withEarly())).toEqual({ text: EARLY, early: true });
  });

  it("the pipeline's summary wins once it lands, from the column or the extraction", () => {
    expect(callSummaryFor(withEarly({ call_summary: FINAL }))).toEqual({ text: FINAL, early: false });
    expect(callSummaryFor(withEarly({ ai_extraction: JSON.stringify({ call_summary: FINAL }) }))).toEqual({ text: FINAL, early: false });
  });

  it("keeps the live-text summary when the pipeline wrote a failure note instead of a summary", () => {
    expect(callSummaryFor(withEarly({ call_summary: "AI extraction returned invalid JSON" }))).toEqual({ text: EARLY, early: true });
    expect(callSummaryFor(withEarly({ call_summary: "Call processing failed 3 time(s); automatic retries exhausted." })))
      .toEqual({ text: EARLY, early: true });
  });

  it("reads metadata stored as a JSON string", () => {
    expect(callSummaryFor({ metadata: JSON.stringify(withEarly().metadata) })).toEqual({ text: EARLY, early: true });
  });
});

describe("CallLogTabV2 summary block", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderWithCalls(calls) {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes("route-calibration")
        ? {}
        : String(url).includes("/admin/call-recordings/stats")
        ? { processing: 0, stalledClaims: 0, failed: 0, retrying: 0, reviewOpen: 0, parkedRecordings: 0 }
        : { calls },
    })));
    render(
      <MemoryRouter initialEntries={["/admin/communications"]}>
        <CallLogTabV2 />
      </MemoryRouter>,
    );
  }
  const call = (id, extra) => ({
    id,
    direction: "inbound",
    from_phone: "+19415550123",
    answered_by: "Virginia",
    created_at: new Date().toISOString(),
    ...extra,
  });

  it("renders the live-text summary under its label, then the pipeline's summary under 'Summary'", async () => {
    renderWithCalls([call("call-1", withEarly()), call("call-2", withEarly({ call_summary: FINAL }))]);
    expect(await screen.findByText(EARLY)).toBeInTheDocument();
    expect(screen.getByText("Summary from the live call")).toBeInTheDocument();
    expect(screen.getByText(FINAL)).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
  });

  it("renders no summary block for a call without a live-text summary", async () => {
    renderWithCalls([call("call-3", { call_summary: FINAL })]);
    expect(await screen.findAllByText("+19415550123")).not.toHaveLength(0);
    expect(screen.queryByText(FINAL)).not.toBeInTheDocument();
    expect(screen.queryByText("Summary from the live call")).not.toBeInTheDocument();
  });
});

describe("awaitingSummary", () => {
  const NOW = Date.parse("2026-11-17T15:05:00.000Z");
  const stopped = (agoMs, live = {}, extra = {}) => ({
    metadata: { live_transcription: { stopped_at: new Date(NOW - agoMs).toISOString(), ...live } },
    ...extra,
  });
  const CLAIM = { early_summary_claimed_at: "2026-11-17T15:00:03.000Z" };

  it("waits for a claimed or written early summary until the pipeline's summary lands", () => {
    expect(awaitingSummary(stopped(5 * 60 * 1000, CLAIM), NOW)).toBe(true);
    expect(awaitingSummary(stopped(5 * 60 * 1000, { ...CLAIM, early_summary: { text: EARLY } }), NOW)).toBe(true);
    expect(awaitingSummary(stopped(5 * 60 * 1000, { ...CLAIM, early_summary: { text: EARLY } }, { call_summary: FINAL }), NOW)).toBe(false);
  });

  it("waits a minute for the claim, then stops for a call that got none (gate off)", () => {
    expect(awaitingSummary(stopped(30 * 1000), NOW)).toBe(true);
    expect(awaitingSummary(stopped(2 * 60 * 1000), NOW)).toBe(false);
  });

  it("stops 10 minutes after the live text stopped, and never waits on a call with no live text", () => {
    expect(awaitingSummary(stopped(11 * 60 * 1000, { ...CLAIM, early_summary: { text: EARLY } }), NOW)).toBe(false);
    expect(awaitingSummary({ call_summary: FINAL }, NOW)).toBe(false);
    expect(awaitingSummary({ metadata: { live_transcription: { live_at: "x" } } }, NOW)).toBe(false);
    expect(awaitingSummary(null, NOW)).toBe(false);
  });
});

describe("CallLogTabV2 reload while a summary is being written", () => {
  const NOW = Date.parse("2026-11-17T15:00:30.000Z");
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const row = (live, extra = {}) => ({
    id: "call-9",
    direction: "inbound",
    from_phone: "+19415550123",
    answered_by: "Virginia",
    created_at: "2026-11-17T14:55:00.000Z",
    metadata: live ? { live_transcription: { stopped_at: "2026-11-17T15:00:00.000Z", ...live } } : undefined,
    ...extra,
  });

  function renderLive(initial) {
    const state = { calls: initial };
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes("route-calibration")
        ? {}
        : String(url).includes("/admin/call-recordings/stats")
        ? { processing: 0, stalledClaims: 0, failed: 0, retrying: 0, reviewOpen: 0, parkedRecordings: 0 }
        : { calls: state.calls },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/admin/communications"]}>
        <CallLogTabV2 />
      </MemoryRouter>,
    );
    const callLoads = () => fetchMock.mock.calls.filter(([u]) => /\/ai\/admin\/calls\?/.test(String(u))).length;
    return { state, callLoads };
  }

  it("shows the early summary, then the pipeline's, without leaving the tab, then stops reloading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const claimed = { early_summary_claimed_at: "2026-11-17T15:00:03.000Z" };
    const { state, callLoads } = renderLive([row(claimed)]);
    expect(await screen.findAllByText("+19415550123")).not.toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400); // the search box's first debounce load
    const first = callLoads();

    state.calls = [row({ ...claimed, early_summary: { text: EARLY } })];
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS);
    expect(await screen.findByText(EARLY)).toBeInTheDocument();
    expect(callLoads()).toBe(first + 1);

    state.calls = [row({ ...claimed, early_summary: { text: EARLY } }, { call_summary: FINAL })];
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS);
    expect(await screen.findByText(FINAL)).toBeInTheDocument();
    const settled = callLoads();
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS * 3);
    expect(callLoads()).toBe(settled);
  });

  it("never reloads on its own when no call is waiting for a summary", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const { callLoads } = renderLive([
      row(null, { call_summary: FINAL }),
      // live text that stopped 10 minutes ago with no claim: the gate was off for it
      row({ stopped_at: "2026-11-17T14:50:30.000Z" }, { id: "call-10", created_at: "2026-11-17T14:45:00.000Z" }),
    ]);
    expect(await screen.findAllByText("+19415550123")).not.toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    const first = callLoads();
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS * 4);
    expect(callLoads()).toBe(first);
  });
});
