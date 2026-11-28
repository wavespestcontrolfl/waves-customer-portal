// @vitest-environment jsdom
/**
 * Billing audit PR 4 (B-56c / B-61b) regressions for AdminInvoicesPage:
 *  - CreateInvoice "Link a completed service" handles Postgres ISO DATE strings cleanly
 *  - Day-group headers, formatTimelineWhen, and SendReceiptModal warning render in ET
 *  - "Charge in person" (Tap to Pay) is guarded against double-clicks with a ref + busy state
 *  - FollowupPanel cancels stale in-flight fetches on invoice switch and spaces inline spans
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage, { formatTimelineWhen } from "./AdminInvoicesPage";
import { launchTapToPay } from "../../lib/tapToPay";

vi.mock("../../lib/tapToPay", () => ({
  launchTapToPay: vi.fn(),
}));

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeInvoice(overrides = {}) {
  return {
    id: "inv-pr4-1",
    invoice_number: "WPC-PR4-001",
    status: "sent",
    customer_id: "cust-pr4-1",
    first_name: "Pat",
    last_name: "Sample",
    email: "pat@example.invalid",
    phone: "9415550101",
    property_type: "residential",
    total: 120,
    subtotal: 120,
    amount_paid: 0,
    credit_applied: 0,
    service_date: "2026-07-19T00:00:00.000Z",
    due_date: "2026-08-01",
    created_at: "2026-07-19T14:00:00.000Z",
    line_items: [
      { description: "Quarterly Pest Control", quantity: 1, unit_price: 120, amount: 120 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "test-token");
  localStorage.setItem(
    "waves_admin_user",
    JSON.stringify({ id: "admin-1", role: "admin" }),
  );
  launchTapToPay.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("formatTimelineWhen ET formatting (B-56c)", () => {
  it("anchors Today, Yesterday, same-year, and prior-year labels in Eastern Time", () => {
    // 2026-07-19 2:00 PM EDT
    const now = new Date("2026-07-19T18:00:00.000Z");
    // 2026-07-19 10:30 PM EDT (already July 20 in UTC!)
    expect(formatTimelineWhen("2026-07-20T02:30:00.000Z", now)).toBe(
      "Today at 10:30 PM",
    );
    // 2026-07-18 11:15 PM EDT (July 19 03:15Z in UTC, but Yesterday in ET)
    expect(formatTimelineWhen("2026-07-19T03:15:00.000Z", now)).toBe(
      "Yesterday at 11:15 PM",
    );
    // Earlier same year: 2026-04-05 9:05 AM EDT
    expect(formatTimelineWhen("2026-04-05T13:05:00.000Z", now)).toMatch(
      /^Apr 5, 9:05 AM$/,
    );
    // Prior year: 2025-12-31 11:30 PM EST (already Jan 1, 2026 in UTC!)
    expect(formatTimelineWhen("2026-01-01T04:30:00.000Z", now)).toBe(
      "Dec 31, 2025",
    );
    expect(formatTimelineWhen(null, now)).toBe("");
    expect(formatTimelineWhen("not-a-date", now)).toBe("");
  });
});

describe("AdminInvoicesPage CreateInvoice service-record date handling (B-56c)", () => {
  it("formats Postgres ISO DATE service records cleanly and populates the date input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/admin/invoices") return jsonResponse({ invoices: [], total: 0 });
        if (url.pathname === "/api/admin/invoices/stats") return jsonResponse({ paid: 0, outstanding: 0, overdue: 0 });
        if (url.pathname === "/api/admin/invoices/payment-notices") return jsonResponse({ notices: [] });
        if (url.pathname === "/api/admin/feature-flags") return jsonResponse({ flags: {} });
        if (url.pathname === "/api/admin/discounts") return jsonResponse({ discounts: [] });
        if (url.pathname === "/api/admin/invoices/customers/search") {
          return jsonResponse({
            customers: [{ id: "cust-1", first_name: "Pat", last_name: "Sample", property_type: "residential" }],
          });
        }
        if (url.pathname === "/api/admin/invoices/service-records/cust-1") {
          return jsonResponse({
            records: [
              {
                id: "sr-1",
                service_type: "Quarterly Pest Control",
                service_date: "2026-07-19T00:00:00.000Z",
                tech_name: "Tech One",
              },
            ],
          });
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create invoice", exact: true }));
    const searchInput = await screen.findByLabelText("Find customer");
    fireEvent.change(searchInput, { target: { value: "Pat" } });
    fireEvent.click(await screen.findByRole("button", { name: /Pat Sample/ }));

    const select = await screen.findByLabelText("Link a completed service");
    const option = within(select).getByRole("option", { name: /Quarterly Pest Control/ });
    expect(option).toHaveTextContent("Quarterly Pest Control -- July 19, 2026 -- Tech One");
    expect(option).not.toHaveTextContent("Invalid Date");

    fireEvent.change(select, { target: { value: "sr-1" } });
    expect(screen.getByLabelText("Service date")).toHaveValue("2026-07-19");
  });
});

describe("AdminInvoicesPage ET day grouping, receipt warning, Tap-to-Pay latch, and FollowupPanel (B-56c / B-61b)", () => {
  it("groups created_at fallback invoices by Eastern calendar day and formats SendReceiptModal warning in ET", async () => {
    const inv = makeInvoice({
      status: "paid",
      service_date: null,
      // 10:30 PM EDT on July 19 (already July 20 in UTC)
      created_at: "2026-07-20T02:30:00.000Z",
      receipt_sent_at: "2026-07-20T02:30:00.000Z",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/admin/invoices") return jsonResponse({ invoices: [inv], total: 1 });
        if (url.pathname === "/api/admin/invoices/stats") return jsonResponse({ paid: 1, outstanding: 0, overdue: 0 });
        if (url.pathname === "/api/admin/invoices/payment-notices") return jsonResponse({ notices: [] });
        if (url.pathname === "/api/admin/feature-flags") return jsonResponse({ flags: {} });
        if (url.pathname === `/api/admin/invoices/${inv.id}/attachments`) return jsonResponse({ attachments: [] });
        if (url.pathname === `/api/admin/invoices/${inv.id}/followup`) return jsonResponse({ sequence: null, steps: [] });
        if (url.pathname === `/api/admin/invoices/${inv.id}/recipients`) {
          return jsonResponse({
            customerName: "Pat Sample",
            emailRecipient: { email: inv.email, role: "primary" },
            smsRecipient: { phone: inv.phone },
          });
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Sunday, July 19, 2026")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Pat Sample.*WPC-PR4-001/ });
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "Resend receipt", exact: true }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/A receipt was already sent on 7\/19\/2026, 10:30:00 PM ET\./)).toBeInTheDocument();
  });

  it("prevents duplicate Tap to Pay handoffs on rapid double-click", async () => {
    const inv = makeInvoice();
    const pendingTap = deferred();
    launchTapToPay.mockReturnValue(pendingTap.promise);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/admin/invoices") return jsonResponse({ invoices: [inv], total: 1 });
        if (url.pathname === "/api/admin/invoices/stats") return jsonResponse({ paid: 0, outstanding: 1, overdue: 0 });
        if (url.pathname === "/api/admin/invoices/payment-notices") return jsonResponse({ notices: [] });
        if (url.pathname === "/api/admin/feature-flags") return jsonResponse({ flags: {} });
        if (url.pathname === `/api/admin/invoices/${inv.id}/attachments`) return jsonResponse({ attachments: [] });
        if (url.pathname === `/api/admin/invoices/${inv.id}/followup`) return jsonResponse({ sequence: null, steps: [] });
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );

    const row = await screen.findByRole("button", { name: /Pat Sample.*WPC-PR4-001/ });
    fireEvent.click(row);
    const tapBtn = await screen.findByRole("button", { name: "Charge in person", exact: true });
    fireEvent.click(tapBtn);
    fireEvent.click(tapBtn);

    expect(launchTapToPay).toHaveBeenCalledTimes(1);
    expect(tapBtn).toBeDisabled();

    await act(async () => {
      pendingTap.resolve({ status: "canceled" });
      await pendingTap.promise;
    });
    await waitFor(() => expect(tapBtn).toBeEnabled());
  });

  it("FollowupPanel spaces text cleanly and ignores stale responses when switching invoices mid-flight", async () => {
    const inv1 = makeInvoice({ id: "inv-1", invoice_number: "WPC-001", first_name: "First", last_name: "Invoice" });
    const inv2 = makeInvoice({ id: "inv-2", invoice_number: "WPC-002", first_name: "Second", last_name: "Invoice" });
    const slowFollowup1 = deferred();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/admin/invoices") return jsonResponse({ invoices: [inv1, inv2], total: 2 });
        if (url.pathname === "/api/admin/invoices/stats") return jsonResponse({ paid: 0, outstanding: 2, overdue: 0 });
        if (url.pathname === "/api/admin/invoices/payment-notices") return jsonResponse({ notices: [] });
        if (url.pathname === "/api/admin/feature-flags") return jsonResponse({ flags: {} });
        if (url.pathname.endsWith("/attachments")) return jsonResponse({ attachments: [] });
        if (url.pathname === "/api/admin/invoices/inv-1/followup") return slowFollowup1.promise;
        if (url.pathname === "/api/admin/invoices/inv-2/followup") {
          return jsonResponse({
            sequence: {
              status: "active",
              touches_sent: 1,
              step_index: 1,
              next_touch_at: "2026-07-22T14:00:00.000Z",
            },
            steps: [{ label: "Day 1" }, { label: "Day 3" }, { label: "Day 5" }, { label: "Day 7" }],
          });
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /First Invoice.*WPC-001/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second Invoice.*WPC-002/ }));

    expect(await screen.findByText(/Touches sent:/)).toHaveTextContent("Touches sent: 1 of 4");
    expect(screen.getByText(/Next:/)).toHaveTextContent(/Next: Day 3 on 7\/22\/2026, 10:00:00 AM ET/);

    // Late inv-1 response must not overwrite inv-2's FollowupPanel.
    await act(async () => {
      slowFollowup1.resolve(
        jsonResponse({
          sequence: { status: "paused", touches_sent: 3, step_index: 3, paused_reason: "Stale invoice 1" },
          steps: [{ label: "Day 1" }, { label: "Day 3" }, { label: "Day 5" }, { label: "Day 7" }],
        }),
      );
      await slowFollowup1.promise;
    });

    expect(screen.queryByText(/Stale invoice 1/)).not.toBeInTheDocument();
    expect(screen.getByText(/Touches sent:/)).toHaveTextContent("Touches sent: 1 of 4");
  });
});
