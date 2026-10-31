// @vitest-environment jsdom
/**
 * Billing audit 2026-10-30, findings 3, 4, 6 and 7 for the admin Invoices page.
 * Synthetic fixtures only; the API is a stubbed fetch.
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage, {
  buildInvoiceListParams,
  receiptDeliveryOutcome,
} from "./AdminInvoicesPage";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const customer = {
  id: "billing-audit-customer",
  first_name: "Audit",
  last_name: "Fixture",
  email: "audit@example.invalid",
  phone: "9415550100",
  property_type: "residential",
};

function fixtureInvoice(overrides = {}) {
  return {
    ...customer,
    customer_id: customer.id,
    id: "billing-audit-invoice",
    invoice_number: "WPC-AUDIT-001",
    status: "overdue",
    total: 100,
    amount_paid: 40,
    credit_applied: 10,
    due_date: "2026-01-01",
    service_date: "2026-01-01",
    line_items: [
      {
        description: "Audit service",
        quantity: 1,
        unit_price: 100,
        amount: 100,
      },
    ],
    ...overrides,
  };
}

function installInvoiceFetch(
  invoice,
  { paymentPlanResponse, receiptResponses = [] } = {},
) {
  const requests = [];
  const receiptQueue = [...receiptResponses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost");
      const method = options.method || "GET";
      const key = `${method} ${url.pathname}`;
      requests.push({
        key,
        url,
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (key === "GET /api/admin/feature-flags")
        return response({ flags: {} });
      if (key === "GET /api/admin/invoices")
        return response({ invoices: [invoice], total: 1, page: 1 });
      if (key === "GET /api/admin/invoices/stats")
        return response({ paid: 0, outstanding: 1, overdue: 1 });
      if (key === "GET /api/admin/invoices/payment-notices")
        return response({ notices: [] });
      if (key === `GET /api/admin/invoices/${invoice.id}`)
        return response(invoice);
      if (key === `GET /api/admin/invoices/${invoice.id}/attachments`)
        return response({ attachments: [] });
      if (key === `GET /api/admin/invoices/${invoice.id}/followup`)
        return response({ sequence: null, steps: [] });
      if (key === `GET /api/admin/invoices/${invoice.id}/recipients`) {
        return response({
          customerName: "Audit Fixture",
          emailRecipient: { email: invoice.email, role: "primary" },
          smsRecipient: { phone: invoice.phone },
        });
      }
      if (key === `POST /api/admin/invoices/${invoice.id}/payment-plan`) {
        return response(
          paymentPlanResponse || {
            ok: true,
            paymentPlan: { id: "audit-plan" },
          },
        );
      }
      if (key === `POST /api/admin/invoices/${invoice.id}/send-receipt`) {
        const next = receiptQueue.shift() || {
          ok: true,
          email: { ok: true },
          sms: { ok: true },
        };
        return response(next);
      }
      return response({ error: `Unmatched audit request: ${key}` }, 500);
    }),
  );
  return requests;
}

async function openExpandedInvoice(invoice) {
  render(
    <MemoryRouter initialEntries={["/admin/invoices"]}>
      <AdminInvoicesPage />
    </MemoryRouter>,
  );
  const row = await screen.findByRole("button", {
    name: new RegExp(
      `${invoice.first_name} ${invoice.last_name}.*${invoice.invoice_number}`,
    ),
  });
  fireEvent.click(row);
  await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "true"));
}

async function openPaymentPlan(invoice) {
  await openExpandedInvoice(invoice);
  fireEvent.click(
    screen.getByRole("button", { name: "Payment plan", exact: true }),
  );
  return within(
    await screen.findByRole("dialog", {
      name: "Create payment plan",
      exact: true,
    }),
  );
}

async function openReceiptDialog(invoice) {
  await openExpandedInvoice(invoice);
  fireEvent.click(
    screen.getByRole("button", { name: "Send receipt", exact: true }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  const send = dialog.getByRole("button", {
    name: "Send receipt",
    exact: true,
  });
  await waitFor(() => expect(send).toBeEnabled());
  return dialog;
}

const originalWidth = window.innerWidth;
const setViewportWidth = (width) => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "billing-audit-token");
  localStorage.setItem(
    "waves_admin_user",
    JSON.stringify({ id: "audit-user", role: "admin" }),
  );
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setViewportWidth(originalWidth);
});

describe("finding 7: invoice date presets are bounded on the Eastern calendar", () => {
  const at = (iso) =>
    vi.useFakeTimers({ toFake: ["Date"] }) && vi.setSystemTime(new Date(iso));
  const range = (datePeriod) => {
    const params = buildInvoiceListParams({ datePeriod });
    return { from: params.get("from"), to: params.get("to") };
  };

  it("sends from and to for every preset, with `to` = today in Eastern", () => {
    at("2026-10-30T15:00:00Z"); // 11:00 AM ET
    expect(range("today")).toEqual({ from: "2026-10-30", to: "2026-10-30" });
    expect(range("7d")).toEqual({ from: "2026-10-23", to: "2026-10-30" });
    expect(range("30d")).toEqual({ from: "2026-09-30", to: "2026-10-30" });
    expect(range("month")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
  });

  it("uses the Eastern date in the evening, when the UTC date is already tomorrow", () => {
    at("2026-10-31T03:30:00Z"); // 11:30 PM ET on Oct 30
    expect(range("today")).toEqual({ from: "2026-10-30", to: "2026-10-30" });
    expect(range("7d")).toEqual({ from: "2026-10-23", to: "2026-10-30" });
    expect(range("month")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
  });

  it("keeps the 7 and 30 day lower bounds on the Eastern calendar across the fall DST change", () => {
    at("2026-11-02T04:30:00Z"); // 11:30 PM ET on Nov 1 (after clocks went back)
    expect(range("today")).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(range("7d")).toEqual({ from: "2026-10-25", to: "2026-11-01" });
    expect(range("30d")).toEqual({ from: "2026-10-02", to: "2026-11-01" });
  });

  it("excludes an invoice dated tomorrow under the server's inclusive from/to rule", () => {
    at("2026-10-31T03:30:00Z");
    const { from, to } = range("today");
    const serverKeeps = (serviceDate) =>
      serviceDate >= from && serviceDate <= to;
    expect(serverKeeps("2026-10-30")).toBe(true);
    expect(serverKeeps("2026-10-31")).toBe(false); // service date tomorrow (ET)
    expect(serverKeeps("2026-11-15")).toBe(false);
  });

  it("sends neither bound for All dates", () => {
    const params = buildInvoiceListParams({ datePeriod: "all" });
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
  });
});

describe("finding 3: payment plan uses what is still owed", () => {
  it("shows $50 owed and defaults the installment to a third of it for $100 with $40 paid and $10 credit", async () => {
    const invoice = fixtureInvoice({
      total: 100,
      amount_paid: 40,
      credit_applied: 10,
    });
    const requests = installInvoiceFetch(invoice);
    const dialog = await openPaymentPlan(invoice);

    expect(dialog.getByText(/\$50\.00 owed/)).toBeInTheDocument();
    expect(dialog.queryByText(/\$100\.00/)).not.toBeInTheDocument();
    expect(dialog.getByLabelText("Payment amount")).toHaveValue(16.67);

    fireEvent.click(
      dialog.getByRole("button", { name: "Create plan", exact: true }),
    );
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.key === `POST /api/admin/invoices/${invoice.id}/payment-plan`,
        ),
      ).toBe(true),
    );
    const post = requests.find(
      (r) => r.key === `POST /api/admin/invoices/${invoice.id}/payment-plan`,
    );
    expect(post.body.totalBalance).toBe(50);
    expect(post.body.paymentAmount).toBe(16.67);
  });

  it("defaults inside the $20 owed after $80 credit and blocks an installment above it", async () => {
    const invoice = fixtureInvoice({
      total: 100,
      amount_paid: 0,
      credit_applied: 80,
    });
    const requests = installInvoiceFetch(invoice);
    const dialog = await openPaymentPlan(invoice);

    const amount = dialog.getByLabelText("Payment amount");
    expect(amount).toHaveValue(6.67);
    const create = dialog.getByRole("button", {
      name: "Create plan",
      exact: true,
    });
    expect(create).toBeEnabled();

    fireEvent.change(amount, { target: { value: "33.34" } });
    expect(create).toBeDisabled();
    expect(dialog.getByText(/no more than \$20\.00/)).toBeInTheDocument();

    fireEvent.change(amount, { target: { value: "20" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.key === `POST /api/admin/invoices/${invoice.id}/payment-plan`,
        ),
      ).toBe(true),
    );
    const post = requests.find(
      (r) => r.key === `POST /api/admin/invoices/${invoice.id}/payment-plan`,
    );
    expect(post.body.totalBalance).toBe(20);
    expect(post.body.paymentAmount).toBe(20);
  });
});

describe("finding 4: partially paid rows stay readable on mobile", () => {
  const summary = () => screen.getByTestId("invoice-row-part-payment");

  it("puts the part-payment summary under the customer and invoice number on a phone", async () => {
    setViewportWidth(390);
    const invoice = fixtureInvoice({
      first_name: "Partially",
      last_name: "Paid",
    });
    installInvoiceFetch(invoice);
    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );
    await screen.findByRole("button", {
      name: /Partially Paid.*WPC-AUDIT-001/,
    });

    expect(summary()).toHaveTextContent("Paid so far $40.00 · $50.00 owed");
    // Same column as the name and invoice number, so the right-hand column stays narrow.
    const leftColumn = summary().parentElement;
    expect(within(leftColumn).getByText(/Partially Paid/)).toBeInTheDocument();
    expect(within(leftColumn).getByText("#WPC-AUDIT-001")).toBeInTheDocument();
    const rightColumn = screen.getByText("$100.00").parentElement;
    expect(rightColumn).not.toContainElement(summary());
  });

  it("keeps the summary in the right-hand block on desktop", async () => {
    setViewportWidth(1440);
    const invoice = fixtureInvoice({
      first_name: "Partially",
      last_name: "Paid",
    });
    installInvoiceFetch(invoice);
    render(
      <MemoryRouter initialEntries={["/admin/invoices"]}>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );
    await screen.findByRole("button", {
      name: /Partially Paid.*WPC-AUDIT-001/,
    });

    expect(screen.getAllByTestId("invoice-row-part-payment")).toHaveLength(1);
    expect(summary()).toHaveTextContent("Paid so far $40.00 · $50.00 owed");
    expect(screen.getByText("$100.00").parentElement).toContainElement(
      summary(),
    );
  });
});

describe("finding 6: receipt delivery is reported per channel", () => {
  it("names the failed SMS, keeps the dialog open and does not re-select the email that went out", async () => {
    const invoice = fixtureInvoice({
      status: "paid",
      amount_paid: 100,
      credit_applied: 0,
    });
    const requests = installInvoiceFetch(invoice, {
      receiptResponses: [
        {
          ok: true,
          email: { ok: true },
          sms: { ok: false, error: "provider timeout" },
          invoice: { ...invoice, receipt_sent_at: "2026-10-30T12:00:00Z" },
        },
        { ok: true, email: { ok: false, skipped: true }, sms: { ok: true } },
      ],
    });
    const dialog = await openReceiptDialog(invoice);
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );

    // The dialog stays up and says what happened on each channel.
    const message = await screen.findAllByText(
      /Email sent\. SMS failed: provider timeout\./,
    );
    expect(message.length).toBeGreaterThan(0);
    expect(screen.queryByText("Receipt sent")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Only the failed channel stays selected.
    const emailBox = dialog.getByRole("checkbox", { name: /Email/ });
    const smsBox = dialog.getByRole("checkbox", { name: /SMS/ });
    expect(emailBox).not.toBeChecked();
    expect(smsBox).toBeChecked();

    // Retry sends SMS only; once it lands the dialog closes with the plain confirmation.
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Receipt sent")).toBeInTheDocument();
    const posts = requests.filter(
      (r) => r.key === `POST /api/admin/invoices/${invoice.id}/send-receipt`,
    );
    expect(posts.map((p) => p.body.via)).toEqual(["both", "sms"]);
  });

  it("does not invite a resend of an email whose outcome is uncertain", async () => {
    const invoice = fixtureInvoice({
      status: "paid",
      amount_paid: 100,
      credit_applied: 0,
    });
    installInvoiceFetch(invoice, {
      receiptResponses: [
        {
          ok: true,
          email: {
            ok: false,
            error: "socket hang up",
            deliveryOutcome: "uncertain",
          },
          sms: { ok: true },
        },
      ],
    });
    const dialog = await openReceiptDialog(invoice);
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );

    expect(
      (
        await screen.findAllByText(
          /Email may have been delivered \(socket hang up\)/,
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Receipt sent")).not.toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /Email/ })).not.toBeChecked();
    expect(dialog.getByRole("checkbox", { name: /SMS/ })).not.toBeChecked();
    expect(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    ).toBeDisabled();
  });

  it("does not invite a resend of a text the server reads as uncertain (delivery.sms = unknown)", async () => {
    const invoice = fixtureInvoice({
      status: "paid",
      amount_paid: 100,
      credit_applied: 0,
    });
    installInvoiceFetch(invoice, {
      receiptResponses: [
        {
          ok: true,
          email: { ok: true },
          sms: { ok: false, error: "provider timeout" },
          delivery: { email: "sent", sms: "unknown" },
        },
      ],
    });
    const dialog = await openReceiptDialog(invoice);
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );

    expect(
      (
        await screen.findAllByText(
          /SMS may have been delivered \(provider timeout\)/,
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/selected to retry/)).not.toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /Email/ })).not.toBeChecked();
    expect(dialog.getByRole("checkbox", { name: /SMS/ })).not.toBeChecked();
    expect(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    ).toBeDisabled();
  });

  it("still says send failed, and keeps both channels selected, when nothing went out", async () => {
    const invoice = fixtureInvoice({
      status: "paid",
      amount_paid: 100,
      credit_applied: 0,
    });
    installInvoiceFetch(invoice, {
      receiptResponses: [
        {
          ok: false,
          email: { ok: false, error: "bounced" },
          sms: { ok: false, error: "provider timeout" },
        },
      ],
    });
    const dialog = await openReceiptDialog(invoice);
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );

    expect(
      (
        await screen.findAllByText(
          "Receipt send failed: bounced · provider timeout",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(dialog.getByRole("checkbox", { name: /Email/ })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: /SMS/ })).toBeChecked();
  });

  it("closes with the plain confirmation when every requested channel was sent", async () => {
    const invoice = fixtureInvoice({
      status: "paid",
      amount_paid: 100,
      credit_applied: 0,
    });
    installInvoiceFetch(invoice, {
      receiptResponses: [{ ok: true, email: { ok: true }, sms: { ok: true } }],
    });
    const dialog = await openReceiptDialog(invoice);
    fireEvent.click(
      dialog.getByRole("button", { name: "Send receipt", exact: true }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Receipt sent")).toBeInTheDocument();
  });
});

describe("finding 6: receipt outcome wording", () => {
  it("names an uncertain leg with no error text as an unknown outcome, never 'not sent'", () => {
    const outcome = receiptDeliveryOutcome(
      {
        ok: true,
        email: { ok: true },
        sms: { ok: false },
        delivery: { email: "sent", sms: "unknown" },
      },
      { email: true, sms: true },
    );
    expect(outcome.uncertain).toEqual(["sms"]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.message).toContain(
      "SMS may have been delivered (outcome unknown).",
    );
    expect(outcome.message).not.toMatch(/not sent/);
  });
});
