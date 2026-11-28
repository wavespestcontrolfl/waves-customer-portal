// @vitest-environment jsdom
// "New estimate" from the customer history panel must carry the account id so
// the builder links the estimate to the customer (member pricing needs it).
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerEstimatesPanel from "./CustomerEstimatesPanel";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const customer = {
  first_name: "Avery",
  last_name: "Example",
  phone: "9415550100",
  email: "avery@example.invalid",
  address_line1: "1 Example Way",
  city: "Testville",
  state: "FL",
  zip: "00000",
};

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  vi.stubGlobal("fetch", vi.fn(async () => ok({ customer, estimates: [], stats: {}, comms: [] })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("CustomerEstimatesPanel new-estimate link", () => {
  it("includes customerId plus the contact params", async () => {
    render(
      <MemoryRouter>
        <CustomerEstimatesPanel customerId="customer-example" onClose={() => {}} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /new estimate/i });
    const url = new URL(link.getAttribute("href"), "http://localhost");
    expect(url.pathname).toBe("/admin/estimates");
    expect(url.searchParams.get("customerId")).toBe("customer-example");
    expect(url.searchParams.get("customerName")).toBe("Avery Example");
    expect(url.searchParams.get("customerPhone")).toBe("9415550100");
    expect(url.searchParams.get("customerEmail")).toBe("avery@example.invalid");
    expect(url.searchParams.get("address")).toContain("1 Example Way");
  });

  it("renders one-time totals, sending/send_failed/archived badges, and notifies parent on draft delete", async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (opts?.method === "DELETE") return ok({ deleted: true });
      if (String(url).includes("/estimates-summary")) {
        return ok({
          customer,
          estimates: [
            { id: "e1", status: "sent", monthly_total: 0, onetime_total: 450, created_at: "2026-10-01T12:00:00Z" },
            { id: "e2", status: "send_failed", monthly_total: 99, onetime_total: 0, archived_at: "2026-10-02T12:00:00Z", created_at: "2026-10-01T12:00:00Z" },
            { id: "e3", status: "draft", monthly_total: 120, onetime_total: 0, created_at: "2026-10-01T12:00:00Z" },
          ],
          stats: { total: 3, accepted: 0, declined: 0, open: 2 },
        });
      }
      return ok({ comms: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onEstimateChanged = vi.fn();

    render(
      <MemoryRouter>
        <CustomerEstimatesPanel
          customerId="customer-example"
          onClose={() => {}}
          onEstimateChanged={onEstimateChanged}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("$450")).toBeInTheDocument();
    expect(screen.getByText(/one-time/i)).toBeInTheDocument();
    expect(screen.getByText("Send failed")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete draft estimate" }));
    await waitFor(() => expect(onEstimateChanged).toHaveBeenCalledTimes(1));
  });
});
