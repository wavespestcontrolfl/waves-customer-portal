// @vitest-environment jsdom
// Audit repro r2-card-charge-refund-tails-1: MobileCardOnFileSheet charges a
// saved card with no quote call, no expectedTotal binding, and no amount shown.
// This test is EXPECTED TO FAIL on current code (it asserts the desired contract).
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import MobileCardOnFileSheet from "../components/schedule/MobileCardOnFileSheet";
import { UiSurface } from "../components/ui";

const cards = [{ id: "pm-1", method_type: "card", brand: "visa", last_four: "1111", card_funding: "credit" }];
const jsonResponse = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("audit r2-card-charge-refund-tails-1", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "t") });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("quotes, shows a total, and binds expectedTotal before charging (desired contract)", async () => {
    fetch.mockImplementation((url) => {
      if (String(url).includes("/cards")) return jsonResponse({ cards });
      if (String(url).includes("/charge-card-quote")) return jsonResponse({ quote: { base: 100, surcharge: 3, total: 103 } });
      return jsonResponse({ success: true, status: "paid" });
    });
    render(
      <UiSurface density="comfortable">
        <MobileCardOnFileSheet presentation="admin" desktopVisible invoiceId="inv-1" customerId="cust-1" customerName="C" />
      </UiSurface>,
    );
    await screen.findByText("Visa 1111");
    fireEvent.click(screen.getAllByRole("button", { name: /^Charge(?: |$)/ })[0]);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes("/charge-card"))).toBe(true));
    const calls = fetch.mock.calls.map(([u, o]) => [String(u), o]);
    const quoteCall = calls.find(([u]) => u.includes("/charge-card-quote"));
    const chargeCall = calls.find(([u]) => u.endsWith("/charge-card"));
    const body = JSON.parse(chargeCall[1].body);
    // Diagnostics for the audit log
    console.log("AUDIT quoteCall:", !!quoteCall, "chargeBody:", JSON.stringify(body), "dollarText:", !!document.body.textContent.match(/\$\d/));
    expect(quoteCall).toBeTruthy();
    expect(body.expectedTotal).toBe(103);
    expect(document.body.textContent).toMatch(/\$\d/);
  });
});
