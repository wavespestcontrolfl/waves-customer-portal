// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OwedCommitmentsSummary from "./OwedCommitmentsSummary";

const rowFor = (who) => ({
  id: `c-${who}`, call_log_id: `call-${who}`, party: "waves", kind: "callback", description: `Call ${who} back`,
  status: "open", due_at: null, overdue: false, call_started_at: "2026-09-01T14:00:00Z",
});

describe("OwedCommitmentsSummary", () => {
  let pending;
  beforeEach(() => {
    pending = {};
    localStorage.setItem("waves_admin_token", "t");
    // Each customer's request resolves only when the test says so.
    vi.stubGlobal("fetch", vi.fn((url) => new Promise((resolve) => {
      const id = new URL(String(url), "http://x").searchParams.get("customer_id");
      pending[id] = () => resolve({ ok: true, status: 200, json: async () => ({ commitments: [rowFor(id)], enabled: true }) });
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows nothing of the previous customer on switch, and a late response for that customer never lands under the new one", async () => {
    const { rerender } = render(<OwedCommitmentsSummary customerId="A" />);
    pending.A();
    await screen.findByText("Call A back");
    rerender(<OwedCommitmentsSummary customerId="B" />);
    // On the very next render — before any effect — A's rows are gone.
    expect(screen.queryByText("Call A back")).toBeNull();
    expect(screen.queryByTestId("owed-summary")).toBeNull();
    pending.B();
    await screen.findByText("Call B back");
    expect(screen.queryByText("Call A back")).toBeNull();
  });

  it("a request for the previous customer that resolves after the switch is dropped, even when it resolves last", async () => {
    const { rerender } = render(<OwedCommitmentsSummary customerId="A" />);
    // A is still pending when the profile switches to B.
    rerender(<OwedCommitmentsSummary customerId="B" />);
    pending.B();
    await screen.findByText("Call B back");
    // A's slow response lands last.
    pending.A();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Call A back")).toBeNull();
    expect(screen.getByText("Call B back")).toBeInTheDocument();
  });
});
