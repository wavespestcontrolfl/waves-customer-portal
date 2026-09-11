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
  if (path === "/admin/pricing/dashboard") return { totalCustomers: 8, avgLTV: 900, avgCAC: 90, ltvCacRatio: 10, mrr: 1200, funnel: { leads: 10, estimates: 8, accepted: 6, active: 5, retained: 4 }, revenueByStage: {} };
  if (path === "/admin/pricing/calculate-value") return { valueScore: 54, priceRecommendation: "Market rate", positioning: "Synthetic positioning" };
  if (path === "/admin/pricing/upsell-rules") return { rules: [{ id: "rule-1", name: "Synthetic rule", trigger_event: "renewal", offer_service: "mosquito", enabled: true, times_triggered: 2, times_converted: 1 }] };
  if (path === "/admin/pricing/upsell-opportunities") return { opportunities: [{ customerId: "customer-1", customerName: "Synthetic customer", currentTier: "Silver", serviceCount: 2, monthlyRate: 100, potentialAdd: 25, suggestedService: "Mosquito" }] };
  if (path === "/admin/pricing/trigger-upsell/customer-1") return { message: "Synthetic upsell sent" };
  if (path === "/admin/pricing/offers") return { offers: [] };
  if (path === "/admin/pricing/ltv-analysis") return { avgLTV: 900, avgCAC: 90, ltvCacRatio: 10, bestChannel: "Referral", retention12mo: 75, bySource: {} };
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
    fireEvent.click(screen.getByRole("button", { name: "Value equation" }));
    expect(await screen.findByText("Synthetic positioning")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Dream outcome"), { target: { value: "9" } });
    await waitFor(() => {
      const calls = fetch.mock.calls.filter(([url, options]) => url === "/api/admin/pricing/calculate-value" && options?.method === "POST");
      expect(JSON.parse(calls.at(-1)[1].body).dreamOutcome).toBe(9);
    });
    fireEvent.click(screen.getByRole("button", { name: "Upsell engine" }));
    expect(await screen.findByText("Synthetic customer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("Synthetic upsell sent")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/admin/pricing/trigger-upsell/customer-1", expect.objectContaining({ method: "POST" }));
  });
});
