// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OwedTabV2, { dueLabel, whoLabel } from "./OwedTabV2";

const rows = () => [
  {
    id: "c1", call_log_id: "11111111-2222-4333-8444-555555555555", party: "waves", kind: "send_estimate", description: "Send the caller an estimate",
    status: "open", source: "ai", human_state: null, due_at: null, overdue: true, call_started_at: "2026-09-01T14:00:00Z",
    customer_id: "cust-1", customer_first_name: "Test", customer_last_name: "Customer", from_phone: "+15555550123", direction: "inbound",
    fulfillment: null, extractor_version: "commitments-v1",
  },
  {
    id: "c2", call_log_id: "22222222-2222-4333-8444-555555555555", party: "waves", kind: "callback", description: "Call the caller back (promised by the AI phone assistant)",
    status: "open", source: "ai", human_state: null, due_at: "2026-09-09T13:00:00Z", overdue: false, call_started_at: "2026-09-02T14:00:00Z",
    customer_id: null, from_phone: "+15555550177", direction: "inbound",
    fulfillment: { kind: "outbound_call", strength: "association", basis: "completed_outbound_call_to_caller_within_14_days", matched_at: "2026-09-03T14:00:00Z" },
    extractor_version: "relay-v1",
  },
];

let calls;
beforeEach(() => {
  calls = [];
  localStorage.setItem("waves_admin_token", "t");
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/commitments/open")) return { ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3 }) };
    return { ok: true, status: 200, json: async () => ({ commitment: {} }) };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("OwedTabV2", () => {
  it("paints only the latest response: a filter change while an earlier load is pending is not overwritten when the older reply lands", async () => {
    let releaseFirst;
    const firstReply = new Promise((resolve) => { releaseFirst = resolve; });
    globalThis.fetch.mockImplementation(async (url) => {
      if (String(url).includes("party=waves")) { await firstReply; return { ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3 }) }; }
      return { ok: true, status: 200, json: async () => ({ commitments: [], overdue_implicit_days: 3 }) };
    });
    render(<OwedTabV2 />);
    fireEvent.change(screen.getByLabelText("Whose promises"), { target: { value: "customer" } });
    await waitFor(() => expect(screen.getByText(/Nothing owed/)).toBeInTheDocument());
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Send the caller an estimate")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing owed/)).toBeInTheDocument();
  });

  it("lists open promises overdue-first with who, source, and the possibly-kept hint", async () => {
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText("Send the caller an estimate")).toBeInTheDocument());
    expect(calls[0].url).toContain("/admin/call-recordings/commitments/open?party=waves");
    expect(screen.getByText(/Overdue · open since/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test Customer" })).toHaveAttribute("href", "/admin/customers?customerId=cust-1");
    expect(screen.getByText("AI assistant")).toBeInTheDocument();
    expect(screen.getByText(/Possibly kept: outbound call/)).toBeInTheDocument();
    expect(screen.getByText(/2 open · 1 overdue/)).toBeInTheDocument();
  });

  it("walks a queue longer than one page with Load more, appending rows at the server's next offset", async () => {
    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: null });
      if (String(url).includes("offset=200")) return { ok: true, status: 200, json: async () => ({ commitments: [{ ...rows()[1], id: "c3", description: "Send the WDO paperwork" }], has_more: false, next_offset: null, overdue_implicit_days: 3 }) };
      return { ok: true, status: 200, json: async () => ({ commitments: rows(), has_more: true, next_offset: 200, overdue_implicit_days: 3 }) };
    });
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText(/2\+ open/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("Send the WDO paperwork")).toBeInTheDocument());
    expect(calls.find((c) => c.url.includes("offset=200")).url).toContain("limit=200");
    expect(screen.getByText("Send the caller an estimate")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText(/3 open/)).toBeInTheDocument();
  });

  it("marks a promise done through the PATCH endpoint and reloads", async () => {
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Mark done" })[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Mark done" })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.url).toContain("/admin/call-recordings/commitments/c1");
    expect(patch.body).toEqual({ action: "fulfill" });
    expect(calls.filter((c) => c.url.includes("/commitments/open"))).toHaveLength(2);
  });

  it("Open call deep-links the Calls tab to that call", async () => {
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open call" })[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Open call" })[0]);
    expect(window.location.hash).toBe("#tab=calls&call=11111111-2222-4333-8444-555555555555");
  });

  it("shows the empty state and a load error with retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ commitments: [], overdue_implicit_days: 3 }) })));
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText(/Nothing owed/)).toBeInTheDocument());
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, statusText: "Server Error", clone: () => ({ json: async () => ({ error: "boom" }) }) })));
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hides Mark done / Dismiss when the gate is off, keeps Open call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3, enabled: false }) })));
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText("Send the caller an estimate")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open call" })).toHaveLength(2);
    expect(screen.getByText(/GATE_CALL_COMMITMENTS is on/)).toBeInTheDocument();
  });

  it("labels due state honestly", () => {
    const now = new Date("2026-09-05T15:00:00Z").getTime();
    expect(dueLabel({ overdue: true, due_at: "2026-09-04T15:00:00Z" }, now).tone).toBe("alert");
    expect(dueLabel({ overdue: false, due_at: "2026-09-05T20:00:00Z" }, now).tone).toBe("strong");
    // A stated deadline that passed after the page loaded is overdue now, whatever the snapshot said (codex #3725 r19 P2).
    expect(dueLabel({ overdue: false, due_at: "2026-09-05T14:00:00Z" }, now)).toMatchObject({ tone: "alert" });
    expect(dueLabel({ overdue: false, due_at: null }, now)).toEqual({ text: "No due time", tone: "neutral" });
    // A human-recorded promise is open since it was recorded, not since the (older) call.
    expect(dueLabel({ overdue: true, due_at: null, source: "human", created_at: "2026-09-01T15:00:00Z", call_started_at: "2026-07-01T15:00:00Z" }, now).text).toMatch(/open since Sep 1/);
    expect(dueLabel({ overdue: true, due_at: null, source: "ai", created_at: "2026-09-01T15:00:00Z", call_started_at: "2026-07-01T15:00:00Z" }, now).text).toMatch(/open since Jul 1/);
    expect(whoLabel({ customer_first_name: "A", customer_last_name: "B" })).toBe("A B");
    expect(whoLabel({ direction: "outbound", to_phone: "+15555550101", from_phone: "+15555550100" })).toBe("+15555550101");
  });
});
