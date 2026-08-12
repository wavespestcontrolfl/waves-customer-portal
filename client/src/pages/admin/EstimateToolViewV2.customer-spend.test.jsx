// @vitest-environment jsdom
// Regression: relinking the builder from one customer to another left the
// PREVIOUS customer's per-application prices on screen until the new
// customer's spend request resolved. The existing-customer chip switches
// names the instant staff clicks the new customer, so during that window the
// panel captioned customer A's prices with customer B's name — and these are
// the figures the office quotes an upgrade from. The cancelled guard already
// stopped a slow response from landing on top of a newer one; it could not
// stop the stale render that preceded it.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

const CUSTOMER_A = {
  id: "cust-a", firstName: "Alice", lastName: "Anders", tier: "Bronze", monthlyRate: 0,
};
const CUSTOMER_B = {
  id: "cust-b", firstName: "Bob", lastName: "Baker", tier: "Silver", monthlyRate: 0,
};

const spendFor = (perVisit, tierLabel) => ({
  currentServices: [{
    key: "pest_control",
    label: "Pest Control",
    currentPerVisit: perVisit,
    cadenceLabel: "Quarterly",
    visitsPerYear: 4,
    spendSource: "last_paid_invoice",
    qualifiesForWaveGuard: true,
  }],
  currentSpendPerVisitTotal: perVisit,
  currentTierLabel: tierLabel,
  currentDiscountPct: 0,
  existingServiceKeys: ["pest_control"],
});

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    clone() { return this; },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// Held open so the assertion can run while customer B's request is still in
// flight — that pending window IS the bug.
let releaseCustomerB;
const customerBPending = () => new Promise((resolve) => { releaseCustomerB = resolve; });

async function linkCustomer(container, fullName) {
  const search = container.querySelector(
    'input[placeholder="Name, phone, email, or address..."]',
  );
  fireEvent.change(search, { target: { value: fullName } });
  const row = await waitFor(
    () => {
      const el = screen.getByRole("button", { name: new RegExp(fullName) });
      expect(el).toBeTruthy();
      return el;
    },
    { timeout: 3000 },
  );
  fireEvent.click(row);
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  releaseCustomerB = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/customer-spend/cust-a")) return jsonResponse(spendFor(117, "Bronze"));
      if (path.includes("/customer-spend/cust-b")) {
        return customerBPending().then(() => jsonResponse(spendFor(64.25, "Silver")));
      }
      if (path.includes("/admin/customers")) {
        return jsonResponse({ customers: [CUSTOMER_A, CUSTOMER_B] });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the builder's current-spend panel follows the linked customer", () => {
  it("drops the previous customer's per-application prices the moment staff relinks", async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );

    await linkCustomer(container, "Alice Anders");
    await waitFor(() => expect(screen.getByText("$117.00")).toBeInTheDocument());

    // Relink to B. Its spend request is deliberately still in flight.
    await linkCustomer(container, "Bob Baker");

    // The fix: Alice's price is gone immediately, rather than sitting under
    // Bob's name until his request lands.
    await waitFor(() => expect(screen.queryByText("$117.00")).not.toBeInTheDocument());
    expect(screen.queryByText("Currently pays per application")).not.toBeInTheDocument();

    // And Bob's own figures render once his request resolves.
    releaseCustomerB();
    await waitFor(() => expect(screen.getByText("$64.25")).toBeInTheDocument());
  });
});
