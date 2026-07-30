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
    expect(screen.getByText(/Jane Veteran/)).toBeInTheDocument();
  });
});
