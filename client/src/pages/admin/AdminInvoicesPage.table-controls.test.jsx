// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage from "./AdminInvoicesPage";

const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const invoice = (id, status = "sent") => ({
  id: `invoice-${id}`,
  invoice_number: `INV-${id}`,
  customer_id: `customer-${id}`,
  first_name: "Customer",
  last_name: String(id),
  status,
  total: 100 + Number(id || 0),
  due_date: "2099-12-31",
  service_date: "2026-10-20",
  line_items: [],
});

let requests;
let listResponse;
let detailResponse;
let batchResponse;
const invoiceRequests = () =>
  requests.filter((request) => request.url.pathname === "/api/admin/invoices");

beforeEach(() => {
  requests = [];
  listResponse = (url) => {
    const page = Number(url.searchParams.get("page") || 1);
    return json({ invoices: [invoice(page)], total: 250, page });
  };
  detailResponse = () => json(invoice("deep"));
  batchResponse = () =>
    json({
      total: 1,
      sent_count: 1,
      failed_count: 0,
      held_count: 0,
    });
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem(
    "waves_admin_user",
    JSON.stringify({ id: "fixture-user", role: "admin" }),
  );
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost");
      const method = options.method || "GET";
      requests.push({ method, url });
      if (method === "GET" && url.pathname === "/api/admin/invoices") {
        return listResponse(url);
      }
      if (method === "GET" && url.pathname === "/api/admin/invoices/stats") {
        return json({ paid: 0, outstanding: 250, overdue: 0 });
      }
      if (
        method === "GET" &&
        url.pathname === "/api/admin/invoices/payment-notices"
      ) {
        return json({ notices: [] });
      }
      if (method === "GET" && url.pathname === "/api/admin/feature-flags") {
        return json({ flags: {} });
      }
      if (
        method === "POST" &&
        url.pathname === "/api/admin/invoices/batch/send"
      ) {
        return batchResponse();
      }
      if (method === "GET" && url.pathname.startsWith("/api/admin/invoices/")) {
        return detailResponse(url);
      }
      return json({});
    }),
  );
});

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

async function openPage(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AdminInvoicesPage />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: /Customer 1.*INV-1/ });
}

describe("invoice table controls preview", () => {
  it("replaces pages, reports exact totals, corrects a shrunken range, and resets search and size to page 1", async () => {
    let shrunk = false;
    listResponse = (url) => {
      const page = Number(url.searchParams.get("page") || 1);
      if (url.searchParams.get("search") === "needle") {
        return json({ invoices: [invoice(9)], total: 1, page: 1 });
      }
      if (page === 3) {
        shrunk = true;
        return json({ invoices: [], total: 150, page: 3 });
      }
      return json({
        invoices: [invoice(page)],
        total: shrunk ? 150 : 250,
        page,
      });
    };
    await openPage("/admin/invoices?tableControls=1");
    expect(screen.getByText("1–100 of 250 invoices")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: /Customer 2.*INV-2/ });
    expect(screen.queryByText("#INV-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument(),
    );
    expect(
      invoiceRequests()
        .slice(-2)
        .map((request) => request.url.searchParams.get("page")),
    ).toEqual(["3", "2"]);

    fireEvent.change(screen.getByLabelText("Invoices rows per page"), {
      target: { value: "25" },
    });
    await waitFor(() => {
      const latest = invoiceRequests().at(-1).url.searchParams;
      expect([latest.get("page"), latest.get("limit")]).toEqual(["1", "25"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 6");
    fireEvent.change(screen.getByLabelText("Invoices search"), {
      target: { value: "needle" },
    });
    await waitFor(() => {
      const latest = invoiceRequests().at(-1).url.searchParams;
      expect([latest.get("page"), latest.get("search")]).toEqual([
        "1",
        "needle",
      ]);
    });
    expect(await screen.findByText("1–1 of 1 invoices")).toBeInTheDocument();
  });

  it("ignores a stale page response after a newer filter request", async () => {
    let releasePageTwo;
    listResponse = (url) => {
      if (url.searchParams.get("status") === "paid") {
        return json({ invoices: [invoice(8, "paid")], total: 1, page: 1 });
      }
      if (url.searchParams.get("page") === "2") {
        return new Promise((resolve) => {
          releasePageTwo = resolve;
        });
      }
      return json({ invoices: [invoice(1)], total: 200, page: 1 });
    };
    await openPage("/admin/invoices?tableControls=1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(releasePageTwo).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "paid" },
    });
    await screen.findByRole("button", { name: /Customer 8.*INV-8/ });
    await act(async () => {
      releasePageTwo(json({ invoices: [invoice(2)], total: 200, page: 2 }));
    });
    expect(screen.queryByText("#INV-2")).not.toBeInTheDocument();
    expect(screen.getByText("#INV-8")).toBeInTheDocument();
  });

  it("keeps an off-page deep link outside pagination counts", async () => {
    listResponse = () => json({ invoices: [invoice(1)], total: 125, page: 1 });
    await openPage("/admin/invoices?tableControls=1&invoice=invoice-deep");
    expect(
      await screen.findByRole("button", { name: /Customer deep.*INV-deep/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("1–100 of 125 invoices")).toBeInTheDocument();
  });

  it("clears hidden selections on page changes and locks controls during a batch", async () => {
    let releasePageTwo;
    let pageTwoRequests = 0;
    listResponse = (url) => {
      const page = Number(url.searchParams.get("page") || 1);
      if (page === 2 && pageTwoRequests++ === 0) {
        return new Promise((resolve) => {
          releasePageTwo = resolve;
        });
      }
      return json({ invoices: [invoice(page)], total: 250, page });
    };
    await openPage("/admin/invoices?tableControls=1");
    const oldPageCheckbox = screen.getByLabelText("Select invoice INV-1");
    fireEvent.click(oldPageCheckbox);
    expect(screen.getByRole("button", { name: "Send 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(releasePageTwo).toBeTypeOf("function"));
    const selectOldPage = screen.getByRole("button", {
      name: "Select sendable (1)",
    });
    expect(oldPageCheckbox).toBeDisabled();
    expect(oldPageCheckbox).not.toBeChecked();
    expect(selectOldPage).toBeDisabled();
    fireEvent.click(oldPageCheckbox);
    fireEvent.click(selectOldPage);
    const search = screen.getByLabelText("Invoices search");
    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.change(search, { target: { value: "" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(invoiceRequests()).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Send 1" }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => {
      expect(invoiceRequests()).toHaveLength(3);
      expect(invoiceRequests().at(-1).url.searchParams.get("page")).toBe("1");
    });
    await screen.findByText("Page 1 of 3");
    await act(async () => {
      releasePageTwo(json({ invoices: [invoice(2)], total: 250, page: 2 }));
    });
    expect(screen.queryByText("#INV-2")).not.toBeInTheDocument();
    expect(screen.queryByText("Refreshing invoices…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByLabelText("Select invoice INV-2");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(invoiceRequests()).toHaveLength(5));
    await screen.findByText("Page 1 of 3");
    expect(screen.queryByText("Refreshing invoices…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send 1" }),
    ).not.toBeInTheDocument();
    expect(
      requests.filter(
        (request) => request.url.pathname === "/api/admin/invoices/batch/send",
      ),
    ).toHaveLength(0);

    fireEvent.change(search, { target: { value: "needle" } });
    await waitFor(() => expect(invoiceRequests()).toHaveLength(6));
    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => {
      expect(invoiceRequests()).toHaveLength(7);
      expect(invoiceRequests().at(-1).url.searchParams.has("search")).toBe(
        false,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(invoiceRequests()).toHaveLength(7);

    let releaseBatch;
    batchResponse = () =>
      new Promise((resolve) => {
        releaseBatch = resolve;
      });
    fireEvent.click(screen.getByLabelText("Select invoice INV-1"));
    fireEvent.click(screen.getByRole("button", { name: "Send 1" }));
    await waitFor(() => expect(releaseBatch).toBeTypeOf("function"));
    expect(screen.getByLabelText("Invoices search")).toBeDisabled();
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Invoices rows per page")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await act(async () => releaseBatch(json({ total: 1, sent_count: 1 })));
  });

  it("resets a pending first page when only the uncommitted search changed", async () => {
    let releaseInitial;
    listResponse = () => invoiceRequests().length === 1
      ? new Promise((resolve) => { releaseInitial = resolve; })
      : json({ invoices: [invoice(1)], total: 250, page: 1 });
    render(<MemoryRouter initialEntries={["/admin/invoices?tableControls=1"]}>
      <AdminInvoicesPage />
    </MemoryRouter>);
    await waitFor(() => expect(releaseInitial).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Invoices search"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await screen.findByRole("button", { name: /Customer 1.*INV-1/ });
    await act(async () => releaseInitial(json({ invoices: [invoice(9)], total: 250, page: 1 })));
    expect(invoiceRequests()).toHaveLength(2);
    expect(screen.queryByText("#INV-9")).not.toBeInTheDocument();
    expect(screen.queryByText("Refreshing invoices…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("keeps the gated-off list on its accumulating Load more path", async () => {
    listResponse = (url) => {
      const page = Number(url.searchParams.get("page") || 1);
      return json({ invoices: [invoice(page)], total: 101, page });
    };
    await openPage("/admin/invoices?tableControls=0");
    expect(
      screen.queryByRole("navigation", { name: "Invoices pagination" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more (1 of 101)" }),
    );
    await screen.findByRole("button", { name: /Customer 2.*INV-2/ });
    expect(screen.getByText("#INV-1")).toBeInTheDocument();
    const latest = invoiceRequests().at(-1).url.searchParams;
    expect([latest.get("page"), latest.get("limit")]).toEqual(["2", "100"]);
  });
});
