// @vitest-environment jsdom
//
// Shift close review (GATE_SHIFT_CLOSE_REVIEW) on the Approvals tab: a week
// holding a shift the system closed shows a badge, the week detail lists that
// shift with a Confirm clock-out button (POST confirm-auto-close, then reload),
// and a week with none looks exactly as it did.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsTab } from "./TimeTrackingPage";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const week = (extra) => ({
  technician_id: "tech-1",
  tech_name: "Field Tech",
  status: "pending",
  total_shift_minutes: "2520.00",
  regular_minutes: "2400.00",
  overtime_minutes: "0.00",
  job_count: 12,
  total_revenue: "3000.00",
  avg_rpmh: "50.00",
  utilization_pct: "60.00",
  review_token: "tok",
  ...extra,
});

const flagged = {
  id: "shift-1",
  entry_type: "shift",
  clock_in: "2026-10-20T11:30:00Z",
  clock_out: "2026-10-20T21:05:00Z",
  approval_status: "pending",
  auto_closed_at: "2026-10-21T03:00:00Z",
  auto_close_reviewed_at: null,
};

beforeEach(() => localStorage.setItem("waves_admin_token", "synthetic-token"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stub({ weekly, entries }) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push([u, options]);
    if (u.includes("/confirm-auto-close")) return json({ success: true });
    if (u.includes("/week-detail")) return json({ dailies: [], entries });
    return json({ techs: [weekly] });
  }));
  return calls;
}

describe("automatic clock-outs on the approvals tab", () => {
  it("shows a badge and lists the shift, and Confirm posts then reloads the detail", async () => {
    const calls = stub({ weekly: week({ auto_close_pending: 1 }), entries: [flagged] });
    render(<ApprovalsTab showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Field Tech")).toBeInTheDocument());
    expect(screen.getByText("1 automatic clock-out to review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Automatic clock-outs to review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm clock-out" }));

    await waitFor(() => expect(calls.some(([u]) => u.includes("/entries/shift-1/confirm-auto-close"))).toBe(true));
    const [, options] = calls.find(([u]) => u.includes("/confirm-auto-close"));
    expect(options.method).toBe("POST");
    await waitFor(() => expect(calls.filter(([u]) => u.includes("/week-detail")).length).toBeGreaterThan(1));
  });

  it("shows nothing extra for a week with no automatic clock-out, or one already reviewed", async () => {
    stub({
      weekly: week({}),
      entries: [{ ...flagged, auto_close_reviewed_at: "2026-10-22T14:00:00Z" }],
    });
    render(<ApprovalsTab showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Field Tech")).toBeInTheDocument());
    expect(screen.queryByText(/automatic clock-out/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument());
    expect(screen.queryByText("Automatic clock-outs to review")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm clock-out" })).not.toBeInTheDocument();
  });
});
