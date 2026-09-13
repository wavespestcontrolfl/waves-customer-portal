// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PricingLogicPage from "./PricingLogicPage";
import PricingStrategyPage from "./PricingStrategyPage";

vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));
vi.mock("./PricingRealityCheckPage", () => ({ default: () => <div>Pricing audit fixture</div> }));

const pricingConfig = [{
  config_key: "global_labor_rate",
  name: "Loaded labor rate",
  category: "global",
  data: { value: 35, enabled: true },
}];

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => "date,customer\n" };
}

function fixtureFor(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  if (path === "/admin/pricing-config/margin-check") return { waveguardTier: "gold", services: [{ service: "pest", annual: 1200, estimatedCost: 300, materialCostSource: "inventory_cost_per_unit", materialPerVisit: 2.5, afterDiscount: 1020, margin: 0.7 }] };
  if (path.startsWith("/admin/pricing-config/pest-calibration?")) return { summary: { count: 1, avgDelta: 2, avgAbsDelta: 2, outlierCount: 0, byPoolCageSize: [], byLotBand: [], reviewQueue: [] }, sampleHealth: {}, records: [] };
  if (path === "/admin/pricing-config") return { configs: pricingConfig };
  if (path === "/admin/pricing-config/audit-log?limit=30") return { logs: [] };
  if (path === "/admin/pricing/dashboard") return { overview: { totalCustomers: 8, avgLTV: 900, avgCAC: 90, ltvToCacRatio: 10, monthlyRecurringRevenue: 1200, annualizedRecurring: 14400 }, stages: { attraction: { totalLeads: 10, totalEstimates: 8, acceptedEstimates: 6, conversionRate: 75 }, core: { recurringCustomers: 5, monthlyRecurring: 1200, tierBreakdown: {} }, upsell: { avgServicesPerCustomer: 2, totalCompletedServices: 14 }, continuity: { retentionBuckets: { '0-3mo': 1, '3-6mo': 0, '6-12mo': 1, '12-24mo': 2, '24mo+': 1 }, totalRetained: 5 } }, funnel: { leads: 10, estimates: 8, accepted: 6, active: 5 } };
  if (path === "/admin/pricing/calculate-value") return { valueScore: 5.44, inputs: { dreamOutcome: 7, perceivedLikelihood: 7, timeDelay: 3, effortSacrifice: 3 }, priceRecommendation: "Price at top of market. Customers see massive value.", positioning: "Premium — high perceived value, charge accordingly" };
  if (path === "/admin/pricing/upsell-rules") return { rules: [{ id: "rule-1", name: "Synthetic rule", trigger_event: "renewal", offer_service: "mosquito", enabled: true, times_triggered: 2, times_converted: 1 }] };
  // { customer, upsell } pairs and the summary/channel/retention LTV response
  // are what server/routes/admin-pricing-strategy.js actually returns.
  if (path === "/admin/pricing/upsell-opportunities") return { total: 1, opportunities: [{ customer: { id: "customer-1", name: "Synthetic customer", tier: "Silver", monthlyRate: 100, phone: "9415550100" }, upsell: { type: "add_service", service: "Mosquito", pitch: "Synthetic pitch", estimatedMonthlyAdd: 25 } }] };
  // { success, upsell, messageSent } is what the route returns — no `message`.
  if (path === "/admin/pricing/trigger-upsell/customer-1") return { success: true, upsell: { type: "add_service", service: "Mosquito", estimatedMonthlyAdd: 25 }, messageSent: "Synthetic outbound SMS body" };
  if (path === "/admin/pricing/offers") return { offers: [] };
  if (path === "/admin/pricing/ltv-analysis") return { totalTracked: 5, distribution: {}, channelPerformance: [{ source: "Referral", avgCAC: 90, avgLTV: 900, avgRevenue: 800, customerCount: 5, roi: 9 }], churnBreakdown: { low: 5, medium: 0, high: 0 }, retentionCurve: { "3mo": { retained: 5, pct: 100 }, "6mo": { retained: 4, pct: 80 }, "12mo": { retained: 4, pct: 75 }, "24mo": { retained: 2, pct: 40 } }, summary: { avgLTV: 900, avgCAC: 90, avgMonthlyRecurring: 120 } };
  if (path === "/admin/pricing/recalculate-ltv") return { success: true };
  if (path === "/admin/pricing-config/global_labor_rate" && options.method === "PUT") return { success: true };
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: (key) => key === "waves_admin_token" ? "synthetic-token" : key === "waves_admin_user" ? JSON.stringify({ role: "admin" }) : null });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(fixtureFor(url, options))));
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pricing admin new UI foundation", () => {
  it("renders the full pricing logic workspace on shared primitives and preserves margin payloads", async () => {
    const view = render(<MemoryRouter initialEntries={["/admin/pricing-logic?section=logic"]}><PricingLogicPage /></MemoryRouter>);
    expect(await screen.findByText("Loaded labor rate")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pricing", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Service margins" })).toBeInTheDocument();
    expect(screen.getByText("Missing-services pricing spec")).toBeInTheDocument();
    expect(view.container.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Lot SqFt"), { target: { value: "12500" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    await waitFor(() => {
      const calls = fetch.mock.calls.filter(([url, options]) => url === "/api/admin/pricing-config/margin-check" && options?.method === "POST");
      expect(JSON.parse(calls.at(-1)[1].body)).toEqual({ lotSqFt: 12500, homeSqFt: 2000, lawnSqFt: 5000, bedArea: 1500, waveguardTier: "gold" });
    });
  });

  it("keeps nested pricing-config saves on the original config key", async () => {
    render(<MemoryRouter initialEntries={["/admin/pricing-logic"]}><PricingLogicPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Loaded labor rate"));
    const editable = screen.getAllByTitle("Click to edit")[0];
    fireEvent.click(editable);
    fireEvent.change(screen.getByRole("spinbutton", { name: "" }), { target: { value: "42" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "" }));
    await waitFor(() => {
      const call = fetch.mock.calls.find(([url, options]) => url === "/api/admin/pricing-config/global_labor_rate" && options?.method === "PUT");
      expect(JSON.parse(call[1].body)).toEqual({ data: { value: 42, enabled: true } });
    });
  });

  it("preserves strategy calculation and upsell actions", async () => {
    render(<MemoryRouter><PricingStrategyPage /></MemoryRouter>);
    expect(await screen.findByText("Total customers")).toBeInTheDocument();
    // The fixture's five buckets total 5 while only the 6mo+ ones total 4, so
    // these two must differ — that gap is exactly the overcount the funnel row
    // used to have when it reused totalRetained.
    expect(screen.getByText("Stage IV: Continuity").parentElement).toHaveTextContent("5");
    expect(screen.getByText("Retained 6mo+").parentElement).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: "Value equation" }));
    // The production-length positioning and recommendation strings, not the old
    // short synthetic ones — the Badge has to hold the real copy.
    expect(await screen.findByText("Premium — high perceived value, charge accordingly")).toBeInTheDocument();
    expect(screen.getByText("Price at top of market. Customers see massive value.")).toBeInTheDocument();
    expect(screen.getByText("5.44")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Dream outcome"), { target: { value: "9" } });
    await waitFor(() => {
      const calls = fetch.mock.calls.filter(([url, options]) => url === "/api/admin/pricing/calculate-value" && options?.method === "POST");
      expect(JSON.parse(calls.at(-1)[1].body).dreamOutcome).toBe(9);
    });
    fireEvent.click(screen.getByRole("button", { name: "Upsell engine" }));
    expect(await screen.findByText("Synthetic customer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    // The generic success copy is what an operator actually sees, since the
    // route returns no `message` field for the page to prefer.
    expect(await screen.findByText("Upsell SMS sent!")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/admin/pricing/trigger-upsell/customer-1", expect.objectContaining({ method: "POST" }));
  });
});
