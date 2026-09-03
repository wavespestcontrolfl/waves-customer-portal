// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CallLogTabV2, { renderTranscriptWithHighlight } from "./CallLogTabV2";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

describe("CallLogTabV2 standalone navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes("route-calibration")
        ? {}
        : String(url).includes("/admin/call-recordings/stats")
        ? { processing: 1, stalledClaims: 0, failed: 2, retrying: 1, reviewOpen: 3, parkedRecordings: 0, oldestUnfinishedMinutes: 12, p50PassMs7d: 41000 }
        : {
            calls: [{
              id: "call-1",
              direction: "inbound",
              from_phone: "+19415550123",
              caller_city: "Lakewood Ranch",
              caller_state: "FL",
              answered_by: "missed",
              created_at: new Date().toISOString(),
            }],
          },
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps customer creation inside the admin app", async () => {
    const openSpy = vi.spyOn(window, "open");

    render(
      <MemoryRouter initialEntries={["/admin/communications"]}>
        <Routes>
          <Route path="/admin/communications" element={<CallLogTabV2 />} />
          <Route path="/admin/customers/new" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create Lead" }));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/admin/customers/new?phone=%2B19415550123&city=Lakewood+Ranch&state=FL",
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("CallLogTabV2 synced transcript", () => {
  const SEGMENTS = {
    segments: [
      { id: "seg_001", speaker: "A", start_ms: 0, end_ms: 2000, text: "Thanks for calling Waves." },
      { id: "seg_002", speaker: "B", start_ms: 2500, end_ms: 6000, text: "I need a termite inspection." },
    ],
  };
  const CALL = {
    id: "call-2",
    direction: "inbound",
    from_phone: "+19415550123",
    answered_by: "human",
    duration_seconds: 40,
    recording_available: true,
    recording_sid: "RE999",
    transcription: "Agent: Thanks for calling Waves.\nCaller: I need a termite inspection.",
    transcript_structured: SEGMENTS,
    created_at: new Date().toISOString(),
  };

  function stubCalls(payload) {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes("route-calibration") ? {} : payload,
    })));
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderTab() {
    return render(
      <MemoryRouter initialEntries={["/admin/communications"]}>
        <Routes>
          <Route path="/admin/communications" element={<CallLogTabV2 />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders clickable segments when the gate is on and clicking seeks the recording", async () => {
    localStorage.setItem("waves_admin_token", "staff-jwt");
    stubCalls({ calls: [CALL], transcript_sync_enabled: true });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /^Transcription/ }));
    const lines = await screen.findAllByRole("button", { name: /Speaker/ });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveTextContent("0:02");

    // Seeking an unloaded recording is a user-initiated load: the player
    // must fetch through the authenticated proxy, never a raw Twilio URL.
    fireEvent.click(lines[1]);
    await waitFor(() => {
      const audioCall = fetch.mock.calls.find(([u]) => String(u).includes("/call-recordings/audio/"));
      expect(audioCall?.[0]).toBe("/api/admin/call-recordings/audio/RE999");
    });
  });

  it("fails closed: a rejected reload drops the synced view", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("route-calibration")) return { ok: true, json: async () => ({}) };
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ calls: [CALL], transcript_sync_enabled: true }) };
      throw new Error("network down");
    }));
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /^Transcription/ }));
    expect((await screen.findAllByRole("button", { name: /Speaker/ })).length).toBe(2);

    // The search debounce issues a second /ai/admin/calls request — which
    // now rejects. The synced view must not survive on stale data.
    fireEvent.change(screen.getByPlaceholderText(/Search calls/i), { target: { value: "jane" } });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Speaker/ })).not.toBeInTheDocument();
    });
  });

  it("falls back to plain text when the stored segments no longer match the transcript", async () => {
    stubCalls({ calls: [{ ...CALL, transcription: "Agent: Waves Pest Control.\nCaller: I want to cancel my lawn plan." }], transcript_sync_enabled: true });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Transcription/ }));
    expect(screen.queryByRole("button", { name: /Speaker/ })).not.toBeInTheDocument();
    expect(screen.getByText(/cancel my lawn plan/)).toBeInTheDocument();
  });

  it("keeps the plain transcript when the gate is off", async () => {
    stubCalls({ calls: [CALL], transcript_sync_enabled: false });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /^Transcription/ }));
    expect(screen.queryByRole("button", { name: /Speaker/ })).not.toBeInTheDocument();
    expect(screen.getByText(/I need a termite inspection/)).toBeInTheDocument();
  });
});

describe("renderTranscriptWithHighlight", () => {
  afterEach(() => cleanup());

  it("marks a quote the server grounded through punctuation- and case-insensitive matching", () => {
    const text = "Agent: We'll call you back Tuesday, first thing. Caller: Thanks.";
    const { container } = render(<p>{renderTranscriptWithHighlight(text, "we\u2019ll call you back tuesday first thing", "c1")}</p>);
    const mark = container.querySelector("mark#call-transcript-mark-c1");
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("We'll call you back Tuesday, first thing");
    expect(container.textContent).toBe(text);
  });

  it("returns the plain text when the quote is not in the transcript", () => {
    const { container } = render(<p>{renderTranscriptWithHighlight("Agent: fixture line.", "not here", "c1")}</p>);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("Agent: fixture line.");
  });
});

describe("pipeline health line", () => {
  beforeEach(() => {
    localStorage.setItem("waves_admin_token", "t");
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes("/admin/call-recordings/stats")
        ? { processing: 1, stalledClaims: 0, failed: 2, retrying: 1, reviewOpen: 3, parkedRecordings: 0, oldestUnfinishedMinutes: 12, p50PassMs7d: 41000 }
        : String(url).includes("route-calibration") ? {} : { calls: [] },
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders the processing pipeline's live state from the stats endpoint", async () => {
    render(<MemoryRouter><CallLogTabV2 /></MemoryRouter>);
    const line = await screen.findByTestId("pipeline-health");
    expect(line.textContent).toContain("1 processing");
    expect(line.textContent).toContain("2 failed (1 retrying)");
    expect(line.textContent).toContain("3 in review");
    expect(line.textContent).toContain("oldest unfinished 12 min");
    expect(line.textContent).toContain("0 stale claims");
    expect(line.textContent).toContain("p50 pass 41 s (7d)");
  });
});
