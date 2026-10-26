// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import BillingRecoveryPage, { formatMoney, daysSince, formatDateOnly, formatETDate, FREE_REASONS, completionDeepLink } from "./BillingRecoveryPage";

const visit = { scheduled_service_id: "visit-1", customer: "Queue Customer", service_type: "Pest control", completed_at: "2026-10-20T14:00:00Z", price: 129, billable: true };
const payloads = {
  leaks: { summary: { leak_dollars: 129, leak_visits: 1, leak_customers: 1, review_dollars: 95, review_visits: 1 }, leaks: [visit], needs_review: [{ ...visit, scheduled_service_id: "visit-2", customer: "Review Customer", monthly_rate: 95 }] },
  aging: { total_outstanding: 80, total_overdue: 80, invoice_count: 1, aging: { current: 0, days_30: 80, days_60: 0, days_90_plus: 0 }, top_balances: [{ invoice_id: "invoice-1", customer: "AR Customer", status: "overdue", due_date: "2026-10-01", amount: 80 }] },
  risk: { atRisk: 95, count: 1, accounts: [{ id: "customer-1", firstName: "Risk", lastName: "Account", monthlyRate: 95, causes: ["overdue"] }] },
};

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, clone() { return response(body, ok); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function leaksFor(customer) {
  return { ...payloads.leaks, leaks: [{ ...visit, customer }], needs_review: [] };
}

function renderPage(path = "/admin/billing-recovery") {
  return render(<MemoryRouter initialEntries={[path]}><BillingRecoveryPage /></MemoryRouter>);
}

function GateSwitchHarness() {
  const navigate = useNavigate();
  return <><button type="button" onClick={() => navigate("/admin/billing-recovery?feedback=1")}>Enable feedback</button><BillingRecoveryPage /></>;
}

function mockReads({ failLeaksOnce = false } = {}) {
  let leakCalls = 0;
  const fetchMock = vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.includes("/leaks?")) {
      leakCalls += 1;
      if (failLeaksOnce && leakCalls === 1) return response({ error: "Failed to load uninvoiced visits" }, false);
      return response(payloads.leaks);
    }
    if (url.endsWith("/aging")) return response(payloads.aging);
    if (url.endsWith("/at-risk-mrr")) return response(payloads.risk);
    if (options.method === "POST") return response({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BillingRecoveryPage helpers", () => {
  it("formats money with USD + thousands separators", () => {
    expect(formatMoney(3473.85)).toBe("$3,473.85");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("$0.00");
    expect(formatMoney("129")).toBe("$129.00");
  });

  it("daysSince returns null for bad input and a non-negative integer otherwise", () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince("not-a-date")).toBeNull();
    const d = daysSince(new Date(Date.now() - 3 * 86400000).toISOString());
    expect(d).toBeGreaterThanOrEqual(2);
    expect(d).toBeLessThanOrEqual(4);
  });

  it("formatDateOnly renders date-only fields without UTC drift", () => {
    expect(formatDateOnly("2026-06-19")).toBe("6/19/2026");
    expect(formatDateOnly("2026-06-19T00:00:00Z")).toBe("6/19/2026");
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly("garbage")).toBe("garbage");
  });

  it("formatETDate renders timestamps in ET and handles bad input", () => {
    expect(formatETDate(null)).toBe("—");
    expect(formatETDate("garbage")).toBe("—");
    expect(formatETDate("2026-06-18T12:00:00Z")).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("free reasons cover the Adam-locked no-cost taxonomy", () => {
    expect(FREE_REASONS).toContain("In-window rodent trap check");
    expect(FREE_REASONS).toContain("Appointment service (no-cost)");
    expect(FREE_REASONS).toContain("Warranty callback / re-treat");
    expect(FREE_REASONS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("completionDeepLink (status-only completions)", () => {
  it("builds the dispatch ?completeService= deep link with the visit's day", () => {
    expect(completionDeepLink({ scheduled_service_id: "ss-9", scheduled_date: "2026-06-17" }))
      .toBe("/admin/dispatch?tab=schedule&date=2026-06-17&completeService=ss-9");
  });
  it("omits a malformed date and returns null without a visit id", () => {
    expect(completionDeepLink({ scheduled_service_id: "ss-9", scheduled_date: "garbage" }))
      .toBe("/admin/dispatch?tab=schedule&completeService=ss-9");
    expect(completionDeepLink({})).toBeNull();
  });
});

describe("BillingRecoveryPage gated feedback and table controls", () => {
  it.each(["", "?tableControls=0", "?feedback=1"])("keeps queue controls off for %s", async (query) => {
    mockReads();
    renderPage(`/admin/billing-recovery${query}`);
    expect(await screen.findByText("Queue Customer")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it.each(["?tableControls=1", "?tableControls=1&feedback=1"])("scopes queue controls for %s", async (query) => {
    mockReads();
    renderPage(`/admin/billing-recovery${query}`);
    const leakSearch = await screen.findByRole("searchbox", { name: "Uninvoiced visits search" });
    expect(screen.getByRole("searchbox", { name: "Needs review visits search" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Columns" })).not.toBeInTheDocument();
    fireEvent.change(leakSearch, { target: { value: "no match" } });
    expect(screen.getByText("No visits match these controls.")).toBeInTheDocument();
    expect(screen.getByText("Review Customer")).toBeInTheDocument();
    expect(screen.getByText("AR Customer")).toBeInTheDocument();
  });

  it.each(["", "?feedback=0"])("preserves the combined legacy error and retry behavior for %s", async (query) => {
    const fetchMock = mockReads({ failLeaksOnce: true });
    renderPage(`/admin/billing-recovery${query}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load uninvoiced visits");
    expect(screen.queryByText("AR Customer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Queue Customer")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/aging"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/at-risk-mrr"))).toHaveLength(2);
  });

  it("keeps healthy sections visible and retries only a failed source", async () => {
    const fetchMock = mockReads({ failLeaksOnce: true });
    renderPage("/admin/billing-recovery?feedback=1");
    expect(await screen.findByText("AR Customer")).toBeInTheDocument();
    expect(screen.getByText("Risk Account")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Other billing recovery sections are still available");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Queue Customer")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/leaks?")).length).toBe(2));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/aging"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/at-risk-mrr"))).toHaveLength(1);
  });

  it("does not let a slow 90-day response replace the selected 30-day queue", async () => {
    const slow90 = deferred();
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/leaks?days=90")) return slow90.promise;
      if (url.includes("/leaks?days=30")) return response(leaksFor("Thirty Day Customer"));
      if (url.endsWith("/aging")) return response(payloads.aging);
      if (url.endsWith("/at-risk-mrr")) return response(payloads.risk);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    renderPage("/admin/billing-recovery?feedback=1");
    fireEvent.change(screen.getByRole("combobox", { name: "Visit window" }), { target: { value: "30" } });
    expect(await screen.findByText("Thirty Day Customer")).toBeInTheDocument();
    await act(async () => { slow90.resolve(response(leaksFor("Ninety Day Customer"))); await slow90.promise; });
    expect(screen.queryByText("Ninety Day Customer")).not.toBeInTheDocument();
  });

  it("does not let a pending legacy load paint over feedback results", async () => {
    const slowLegacy = deferred();
    let leakCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/leaks?")) {
        leakCalls += 1;
        return leakCalls === 1 ? slowLegacy.promise : response(leaksFor("Preview Customer"));
      }
      if (url.endsWith("/aging")) return response(payloads.aging);
      if (url.endsWith("/at-risk-mrr")) return response(payloads.risk);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<MemoryRouter initialEntries={["/admin/billing-recovery"]}><GateSwitchHarness /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Enable feedback" }));
    expect(await screen.findByText("Preview Customer")).toBeInTheDocument();
    await act(async () => { slowLegacy.resolve(response(leaksFor("Legacy Customer"))); await slowLegacy.promise; });
    expect(screen.queryByText("Legacy Customer")).not.toBeInTheDocument();
  });

  it("announces a successful bill and refreshes every billing recovery source", async () => {
    const fetchMock = mockReads();
    renderPage("/admin/billing-recovery?feedback=1&tableControls=1");
    fireEvent.click((await screen.findAllByRole("button", { name: "Bill" }))[0]);
    expect(await screen.findByText("Draft invoice created. Review and send it from Invoices.")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/leaks?")).length).toBe(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/billing-recovery/visit-1/bill",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/aging"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/at-risk-mrr"))).toHaveLength(2);
  });

  it("refreshes the current window after a pending action resolves", async () => {
    const pendingPost = deferred();
    const leakUrls = [];
    const fetchMock = vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (options.method === "POST") return pendingPost.promise;
      if (url.includes("/leaks?")) {
        leakUrls.push(url);
        return response(leaksFor(url.includes("days=30") ? "Thirty Day Customer" : "Ninety Day Customer"));
      }
      if (url.endsWith("/aging")) return response(payloads.aging);
      if (url.endsWith("/at-risk-mrr")) return response(payloads.risk);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/admin/billing-recovery?feedback=1");
    fireEvent.click((await screen.findAllByRole("button", { name: "Bill" }))[0]);
    fireEvent.change(screen.getByRole("combobox", { name: "Visit window" }), { target: { value: "30" } });
    expect(await screen.findByText("Thirty Day Customer")).toBeInTheDocument();
    pendingPost.resolve(response({ ok: true }));
    expect(await screen.findByText("Draft invoice created. Review and send it from Invoices.")).toBeInTheDocument();
    await waitFor(() => expect(leakUrls).toHaveLength(3));
    expect(leakUrls.map((url) => new URL(url, "http://local").searchParams.get("days"))).toEqual(["90", "30", "30"]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/aging"))).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/at-risk-mrr"))).toHaveLength(3);
  });
});
