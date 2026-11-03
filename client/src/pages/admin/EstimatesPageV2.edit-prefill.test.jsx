// @vitest-environment jsdom
// Regression: the legacy /admin/estimates redirect injects tab=estimates into
// prefill links that omit tab=new (Edit estimate, New estimate for customer,
// the customer panel's + Estimate). Mounting with a non-"new" tab param plus
// prefill let the leave-create-tab cleanup wipe the prefill during the first
// effects pass, so the builder opened blank instead of loading the estimate.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimatesPageV2 from "./EstimatesPageV2";

vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => vi.fn(),
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));

const EDIT_SOURCE = {
  id: "est-1",
  status: "sent",
  editable: true,
  blockReason: null,
  customerId: "cust-1",
  customerName: "Jane Veteran",
  customerPhone: "+19415550123",
  customerEmail: "jane@example.com",
  address: "1 Palm Lane, Bradenton, FL 34205",
  notes: "",
  serviceInterest: "",
  showOneTimeOption: false,
  billByInvoice: false,
  satelliteUrl: null,
  inputs: { svcPest: true },
  engineProfile: null,
};

const MOVE_SOURCE = {
  move: { id: "move-1", address: "123 Palm Ave, Venice, FL 34285", moveOutDate: "2026-11-15", moveInDate: "2026-11-20" },
  customer: { id: "cust-1", name: "Jane Veteran", phone: "+19415550123", email: "jane@example.com" },
  isRecurringCustomer: true,
  source: { estimateId: "est-old", inputs: { svcPest: true, svcMisting: true, manualDiscountPreset: "multi_home", manualDiscountType: "PERCENT", manualDiscountValue: "10", manualDiscountLabel: "Multi-Home Discount" } },
  planServices: [{ name: "Pest Control", frequency: "quarterly" }],
  leftOut: [{ name: "Mosquito Misting", reason: "installed system" }],
};

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    clone() {
      return this;
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/edit-source")) return jsonResponse(EDIT_SOURCE);
      if (path.includes("/estimate-source")) return jsonResponse(MOVE_SOURCE);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/estimates")) return jsonResponse({ estimates: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("edit-estimate prefill survives the legacy redirect's injected tab param", () => {
  it("opens the builder in edit mode when mounted with tab=estimates + editEstimateId", async () => {
    render(
      <MemoryRouter
        initialEntries={["/admin/pipeline?editEstimateId=est-1&tab=estimates"]}
      >
        <Routes>
          <Route path="/admin/pipeline" element={<EstimatesPageV2 />} />
        </Routes>
      </MemoryRouter>,
    );

    // The prefill must reach EstimateToolViewV2 so it fetches the edit source…
    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) =>
            String(url).includes("/api/admin/estimates/est-1/edit-source"),
          ),
      ).toBe(true);
    });

    // …and the builder actually enters edit mode for that estimate.
    expect(
      await screen.findByText(/Editing existing estimate/i),
    ).toBeInTheDocument();
    // The name shows twice by design: the edit banner, and the "Estimate
    // goes to" line that stands in for the closed contact boxes.
    expect(screen.getAllByText(/Jane Veteran/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("estimate-contact-summary")).toHaveTextContent("Jane Veteran");
  });

  it("moveId starts a new-home estimate: fetches the move source and shows the move banner", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/pipeline?tab=new&moveId=move-1&customerId=cust-1"]}>
        <Routes>
          <Route path="/admin/pipeline" element={<EstimatesPageV2 />} />
        </Routes>
      </MemoryRouter>,
    );
    const banner = await screen.findByTestId("move-estimate-banner");
    await waitFor(() => expect(banner).toHaveTextContent("123 Palm Ave, Venice, FL 34285"));
    expect(banner).toHaveTextContent("The $99 setup fee is waived for this move.");
    expect(banner).toHaveTextContent("Today's plan: Pest Control (quarterly)");
    expect(banner).toHaveTextContent("Not copied: Mosquito Misting (installed system)");
    expect(banner).toHaveTextContent("The old estimate had a discount (Multi-Home Discount). Add it again if it still applies.");
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) =>
        String(url).includes("/api/admin/customers/cust-1/moves/move-1/estimate-source"),
      ),
    ).toBe(true);
    // A move is not an edit: the builder stays in create mode.
    expect(screen.queryByText(/Editing existing estimate/i)).toBeNull();
  });
});
