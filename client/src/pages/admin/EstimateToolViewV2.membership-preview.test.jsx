// @vitest-environment jsdom
// 10-30 estimate audit F2 + F3. The one-time loyalty preview must follow the
// server's membership verdict (hasActivePlan on the customer search row), not
// a stricter copy of it, and must not carry one customer's flag to another.
// A revision cannot move to another customer, so its customer search is off.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const row = (id, name, extra) => ({ id, firstName: name, lastName: "Fixture", address: `${id} Synthetic Way`, phone: null, email: null, ...extra });
const ROWS = {
  tierNoRate: row("c-tier", "Tiered", { tier: "Gold", monthlyRate: 0, hasActivePlan: true }),
  rateNoTier: row("c-rate", "Legacy", { tier: null, monthlyRate: 129.5, hasActivePlan: true }),
  commercial: row("c-comm", "Commercial", { tier: "Commercial", monthlyRate: 300, hasActivePlan: false }),
  none: row("c-none", "Plain", { tier: null, monthlyRate: 0, hasActivePlan: false }),
};
const json = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data, clone() { return this; }, text: async () => JSON.stringify(data) });

let searchRows;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "fixture");
  searchRows = [];
  vi.stubGlobal("fetch", vi.fn((url) => {
    if (String(url).startsWith("/api/admin/customers?")) return json({ customers: searchRows });
    if (String(url).startsWith("/api/admin/leads?")) return json({ leads: [] });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const input = () => screen.getByRole("textbox", { name: "Search customers by first name, last name, or full name" });
const loyalty = () => document.getElementById("estimate-isRecurringCustomer");
async function pick(rows, term, nameRe) {
  searchRows = rows;
  fireEvent.change(input(), { target: { value: term } });
  fireEvent.click(await screen.findByRole("button", { name: nameRe }));
}

describe("one-time loyalty preview follows the server membership verdict (F2)", () => {
  it.each([
    ["a tiered member with a zero monthly rate", ROWS.tierNoRate, /Tiered Fixture/],
    ["a legacy member with a rate and no tier", ROWS.rateNoTier, /Legacy Fixture/],
  ])("%s previews with the loyalty perk", async (_label, customer, nameRe) => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    await pick([customer], "fixture", nameRe);
    expect(await screen.findByText(/15% loyalty discount applied/)).toBeInTheDocument();
    expect(loyalty().value).toBe("YES");
  });

  it("a Commercial customer with a rate previews without the loyalty perk", async () => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    await pick([ROWS.commercial], "fixture", /Commercial Fixture/);
    await screen.findByText(/No active plan/);
    expect(screen.queryByText(/15% loyalty discount applied/)).not.toBeInTheDocument();
    expect(loyalty().value).toBe("NO");
  });

  it("picking a non-member after a member does not keep the member's loyalty flag", async () => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    await pick([ROWS.tierNoRate, ROWS.none], "fixture", /Tiered Fixture/);
    await screen.findByText(/15% loyalty discount applied/);
    expect(loyalty().value).toBe("YES");
    fireEvent.change(input(), { target: { value: "plain" } });
    fireEvent.click(await screen.findByRole("button", { name: /Plain Fixture/ }));
    await screen.findByText(/No active plan/);
    expect(screen.queryByText(/15% loyalty discount applied/)).not.toBeInTheDocument();
    expect(loyalty().value).toBe("NO");
  });
});

describe("customer switching while revising (F3)", () => {
  const source = {
    id: "qa-draft", status: "draft", editable: true, editVersion: "v1", customerId: "qa-cust",
    customer: { id: "qa-cust", firstName: "QA", lastName: "Member", tier: "Gold", monthlyRate: 0, hasActivePlan: true },
    customerName: "QA Member", customerPhone: "+19415550100", customerEmail: "qa@example.invalid",
    address: "100 Example Court", propertyId: "qa-property",
    inputs: { svcMosquito: true, mosquitoProgram: "monthly12", homeSqFt: "2000", lotSqFt: "6000" },
    engineRequest: { profile: { homeSqFt: 2000, lotSqFt: 6000 }, selectedServices: ["MOSQUITO"], options: {} },
    result: { recurring: { grandTotal: 0, serviceCount: 0, services: [] }, oneTime: { total: 0, items: [] }, results: {}, totals: { year1: 0 } },
    token: "synthetic-preview-token",
  };
  it("turns the customer search off and says a different customer needs a new estimate", async () => {
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).endsWith("/edit-source")) return json(source);
      if (String(url).includes("/discounts")) return json([]);
      return json({});
    }));
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId={source.id} /></MemoryRouter>);
    await screen.findByDisplayValue("QA Member");
    expect(input()).toBeDisabled();
    expect(screen.getByText(/To quote a different customer, start a new estimate/)).toBeInTheDocument();
  });

  it("leaves the customer search on for a new estimate", () => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    expect(input()).toBeEnabled();
    expect(screen.queryByText(/start a new estimate/)).not.toBeInTheDocument();
  });
});
