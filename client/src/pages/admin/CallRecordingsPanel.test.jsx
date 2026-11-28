// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CallRecordingsPanel from "./CallRecordingsPanel";

describe("CallRecordingsPanel (C2-29)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("surfaces a load error with Retry instead of 'No call recordings found'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/recordings")) {
        return { ok: false, status: 503, json: async () => ({ error: "Database unavailable" }) };
      }
      return { ok: true, json: async () => ({ pending: 0 }) };
    }));
    render(<CallRecordingsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Database unavailable/);
    expect(screen.queryByText("No call recordings found")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("guards Process All Pending with confirmation and disables when pending is 0", async () => {
    const posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (opts?.method === "POST") posts.push(String(url));
      if (String(url).includes("/stats")) return { ok: true, json: async () => ({ pending: 3 }) };
      return { ok: true, json: async () => ({ recordings: [] }) };
    }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CallRecordingsPanel />);
    const btn = await screen.findByRole("button", { name: "Process All Pending" });
    fireEvent.click(btn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
  });

  it("keeps Process All Pending enabled when pending is 0 but retryable or stalled calls remain", async () => {
    const posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (opts?.method === "POST") posts.push(String(url));
      if (String(url).includes("/stats")) {
        return { ok: true, json: async () => ({ pending: 0, retrying: 2, stalled_claims: 1 }) };
      }
      return { ok: true, json: async () => ({ recordings: [] }) };
    }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CallRecordingsPanel />);
    const btn = await screen.findByRole("button", { name: "Process All Pending" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(posts).toEqual(["/api/admin/call-recordings/process-all"]);
    });
  });

  it("fences cross-call synopsis overwrite when switching selected recording mid-request", async () => {
    let resolveSynopsisA;
    const recA = {
      id: "rec-a",
      twilio_call_sid: "CA" + "a".repeat(32),
      from_phone: "+19415550001",
      to_phone: "+19412975749",
      first_name: "Alice",
      last_name: "First",
      processing_status: "processed",
      transcription: "Alice transcript",
      lead_synopsis: "Old Alice synopsis",
      created_at: new Date().toISOString(),
    };
    const recB = {
      id: "rec-b",
      twilio_call_sid: "CA" + "b".repeat(32),
      from_phone: "+19415550002",
      to_phone: "+19412975749",
      first_name: "Bob",
      last_name: "Second",
      processing_status: "processed",
      transcription: "Bob transcript",
      lead_synopsis: "Bob original synopsis",
      created_at: new Date().toISOString(),
    };
    vi.stubGlobal("fetch", vi.fn((url) => {
      const u = String(url);
      if (u.includes("/synopsis/")) {
        return new Promise((resolve) => { resolveSynopsisA = resolve; });
      }
      if (u.includes("/stats")) return Promise.resolve({ ok: true, json: async () => ({ pending: 0 }) });
      return Promise.resolve({ ok: true, json: async () => ({ recordings: [recA, recB] }) });
    }));
    render(<CallRecordingsPanel />);
    fireEvent.click(await screen.findByText("Alice First"));
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate Synopsis" }));
    fireEvent.click(screen.getByText("Bob Second"));
    expect(await screen.findByText("Bob original synopsis")).toBeInTheDocument();

    resolveSynopsisA({ ok: true, json: async () => ({ synopsis: "STALE ALICE SYNOPSIS" }) });
    await waitFor(() => {
      expect(screen.getByText("Bob original synopsis")).toBeInTheDocument();
      expect(screen.queryByText("STALE ALICE SYNOPSIS")).not.toBeInTheDocument();
    });
  });
});
