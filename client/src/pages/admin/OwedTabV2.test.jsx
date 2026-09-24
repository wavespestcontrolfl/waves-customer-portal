// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    status: "open", source: "ai", human_state: null, due_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), overdue: false, call_started_at: "2026-09-02T14:00:00Z",
    customer_id: null, from_phone: "+15555550177", direction: "inbound",
    fulfillment: { kind: "outbound_call", strength: "association", basis: "completed_outbound_call_to_caller_within_14_days", matched_at: "2026-09-03T14:00:00Z" },
    extractor_version: "relay-v1",
  },
];

let calls;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
  calls = [];
  cards.summary = null;
  localStorage.setItem("waves_admin_token", "t");
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/commitments/open")) return { ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3 }) };
    return { ok: true, status: 200, json: async () => ({ commitment: {} }) };
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

// Follow-through has its own browser workflow; these tests isolate the legacy
// ledger. The stub reports whatever summary a test hands it (null = the card
// feed never loaded, which is also what a failed card request reports).
const cards = vi.hoisted(() => ({ summary: null }));
vi.mock("../../components/admin/AdminFollowThroughCards", async () => {
  const { useEffect } = await import("react");
  return { default: ({ onSummary }) => { useEffect(() => { if (cards.summary) onSummary?.(cards.summary); }, [onSummary]); return null; } };
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

  it.each([true, false])("explains the server's active callback deadline policy (cards enabled: %s)", async (enabled) => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      commitments: rows(), overdue_implicit_days: 3, callbacks_enabled: enabled,
    }) });
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText(enabled ? /a callback after four staffed hours/ : /a callback after the day of the call/)).toBeInTheDocument());
    expect(screen.queryByText(enabled ? /a callback after the day of the call/ : /a callback after four staffed hours/)).not.toBeInTheDocument();
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

  it("keeps Waves' callback rows in the ledger until the card feed itself loads enabled", async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3, callbacks_enabled: true }) });
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText("Send the caller an estimate")).toBeInTheDocument());
    expect(screen.getByText(/Call the caller back/)).toBeInTheDocument();
    expect(screen.getByText(/2 open · 1 overdue/)).toBeInTheDocument();
  });

  it("hands Waves' callbacks to the cards once they load, folding their counts and pagination into the summary", async () => {
    cards.summary = { enabled: true, open: 100, overdue: 4, hasMore: true };
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ commitments: rows(), overdue_implicit_days: 3, callbacks_enabled: true }) });
    render(<OwedTabV2 />);
    await waitFor(() => expect(screen.getByText("Send the caller an estimate")).toBeInTheDocument());
    expect(screen.queryByText(/Call the caller back/)).not.toBeInTheDocument();
    expect(screen.getByText(/101\+ open · 5 overdue/)).toBeInTheDocument();
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

  it("recovers polling when a failed action invalidates a pending filter read", async () => {
    let resolvePendingRead;
    let customerReads = 0;
    const stale = { ...rows()[0], id: "stale", description: "Stale customer read" };
    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const path = String(url);
      if (options.method === "PATCH") {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error",
          clone: () => ({ json: async () => ({ error: "Synthetic action failure" }) }),
        };
      }
      if (path.includes("party=customer")) {
        customerReads += 1;
        if (customerReads === 1) {
          return new Promise((resolve) => { resolvePendingRead = resolve; });
        }
        return { ok: true, status: 200, json: async () => ({ commitments: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ commitments: rows() }) };
    });

    render(<OwedTabV2 />);
    await screen.findByText("Send the caller an estimate");
    fireEvent.change(screen.getByLabelText("Whose promises"), { target: { value: "customer" } });
    await waitFor(() => expect(resolvePendingRead).toBeTypeOf("function"));

    fireEvent.click(screen.getAllByRole("button", { name: "Mark done" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic action failure");

    await act(async () => {
      resolvePendingRead({ ok: true, status: 200, json: async () => ({ commitments: [stale] }) });
      await Promise.resolve();
    });
    expect(screen.queryByText(stale.description)).toBeNull();

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText(/Nothing owed/)).toBeInTheDocument();
    expect(customerReads).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(dueLabel({ overdue: false, due_at: null, effective_due_at: "2026-09-05T20:00:00Z" }, now))
      .toMatchObject({ text: expect.stringContaining("Due Sep 5"), tone: "strong" });
    expect(dueLabel({ overdue: false, due_at: null, effective_due_at: "2026-09-05T14:00:00Z" }, now).tone).toBe("alert");
    expect(dueLabel({ overdue: false, due_at: null }, now)).toEqual({ text: "No due time", tone: "neutral" });
    // The server's effective_due_at already carries an active snooze; the label says so.
    expect(dueLabel({ overdue: false, due_at: null, effective_due_at: "2026-09-05T18:00:00Z", snoozed_until: "2026-09-05T18:00:00Z" }, now))
      .toEqual({ text: expect.stringMatching(/^Snoozed until /), tone: "neutral" });
    expect(dueLabel({ overdue: false, due_at: null, effective_due_at: "2026-09-05T14:30:00Z", snoozed_until: "2026-09-05T14:30:00Z" }, now).tone).toBe("alert");
    // A snooze that ends before the deadline is not the deadline.
    expect(dueLabel({ overdue: false, due_at: null, effective_due_at: "2026-09-05T20:00:00Z", snoozed_until: "2026-09-05T17:00:00Z" }, now).text).toMatch(/^Due /);
    // A human-recorded promise is open since it was recorded, not since the (older) call.
    expect(dueLabel({ overdue: true, due_at: null, source: "human", created_at: "2026-09-01T15:00:00Z", call_started_at: "2026-07-01T15:00:00Z" }, now).text).toMatch(/open since Sep 1/);
    expect(dueLabel({ overdue: true, due_at: null, source: "ai", created_at: "2026-09-01T15:00:00Z", call_started_at: "2026-07-01T15:00:00Z" }, now).text).toMatch(/open since Jul 1/);
    expect(whoLabel({ customer_first_name: "A", customer_last_name: "B" })).toBe("A B");
    expect(whoLabel({ direction: "outbound", to_phone: "+15555550101", from_phone: "+15555550100" })).toBe("+15555550101");
  });
});


it("keeps expanded owed pages when refreshing automatically", async () => {
  const first = rows()[0];
  const second = { ...rows()[1], description: "Second page promise" };
  const requested = [];
  globalThis.fetch.mockImplementation(async (url) => {
    requested.push(String(url));
    const later = String(url).includes("offset=200");
    return { ok: true, status: 200, json: async () => ({
      commitments: later ? [second] : [first], has_more: !later, next_offset: later ? null : 200,
    }) };
  });
  render(<OwedTabV2 />);
  await screen.findByText(first.description);
  fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
  await screen.findByText(second.description);
  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(requested.filter((url) => url.includes("offset=200"))).toHaveLength(3));
  expect(screen.getByText(first.description)).toBeInTheDocument();
  expect(screen.getByText(second.description)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

it("restarts an expanded refresh when page-boundary drift skips a row", async () => {
  const first = rows()[0];
  const second = { ...rows()[1], description: "Second page promise" };
  const inserted = { ...first, id: "inserted", description: "Inserted then fulfilled" };
  let requestNumber = 0;
  globalThis.fetch.mockImplementation(async (url) => {
    requestNumber += 1;
    const later = String(url).includes("offset=200");
    let commitments;
    // Initial two-page view.
    if (requestNumber <= 2) commitments = later ? [second] : [first];
    // Walk one: a new first row shifts the old first row across the page
    // boundary, then disappears before offset 200 is read. The offset page
    // skips `first`, producing the incomplete [inserted, second] walk.
    else if (requestNumber <= 4) commitments = later ? [second] : [inserted];
    // Walks two and three see the settled ordering and must agree before it
    // can replace the previously rendered rows.
    else commitments = later ? [second] : [first];
    return { ok: true, status: 200, json: async () => ({
      commitments,
      has_more: !later,
      next_offset: later ? null : 200,
    }) };
  });

  render(<OwedTabV2 />);
  await screen.findByText(first.description);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText(second.description);

  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(requestNumber).toBe(8));
  expect(screen.getByText(first.description)).toBeInTheDocument();
  expect(screen.getByText(second.description)).toBeInTheDocument();
  expect(screen.queryByText(inserted.description)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the rendered expanded queue when three walks never stabilize", async () => {
  const first = rows()[0];
  const second = { ...rows()[1], description: "Second page promise" };
  let requestNumber = 0;
  let unstable = true;
  globalThis.fetch.mockImplementation(async (url) => {
    requestNumber += 1;
    const later = String(url).includes("offset=200");
    const walk = Math.max(0, Math.ceil((requestNumber - 2) / 2));
    const changing = { ...first, id: `changing-${walk}`, description: `Changing row ${walk}` };
    return { ok: true, status: 200, json: async () => ({
      commitments: requestNumber <= 2 || !unstable
        ? (later ? [second] : [first])
        : (later ? [second] : [changing]),
      has_more: !later,
      next_offset: later ? null : 200,
    }) };
  });

  render(<OwedTabV2 />);
  await screen.findByText(first.description);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText(second.description);

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The owed queue changed while refreshing",
  );
  expect(requestNumber).toBe(8);
  expect(screen.getByText(first.description)).toBeInTheDocument();
  expect(screen.getByText(second.description)).toBeInTheDocument();
  unstable = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(requestNumber).toBe(12));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(first.description)).toBeInTheDocument();
  expect(screen.getByText(second.description)).toBeInTheDocument();
});
