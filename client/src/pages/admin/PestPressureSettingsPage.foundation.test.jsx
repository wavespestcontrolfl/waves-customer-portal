// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PestPressureSettingsPage from "./PestPressureSettingsPage";

const config = {
  enabled: true,
  showOnCustomerReport: true,
  showHowCalculated: true,
  showComponentBreakdownToCustomer: false,
  missingDataBehavior: "recalculate_available_components",
  minimumDataRequired: { requireOneOf: ["technicianRating"] },
  allowManualOverride: true,
  allowTechnicianClientRatingEntry: true,
  enabledServiceLines: ["pest", "mosquito"],
  requireRecurringFrequency: true,
  weights: { client: 25, technician: 30, reService: 20, recurring: 15, risk: 10 },
  labels: [
    { key: "very_low", name: "Very Low", min: 0, max: 0.9, description: "Little to no pest activity." },
    { key: "low", name: "Low", min: 1, max: 1.9, description: "Minor activity." },
    { key: "moderate", name: "Moderate", min: 2, max: 2.9, description: "Noticeable activity." },
    { key: "elevated", name: "Elevated", min: 3, max: 3.9, description: "Recurring activity." },
    { key: "high", name: "High", min: 4, max: 5, description: "Heavy activity." },
  ],
  trendThresholds: { improvingAtOrBelow: -0.5, stableBand: 0.4, increasingFrom: 0.5, significantIncreaseFrom: 1 },
  serviceFrequencyWindows: { monthly: 30, bimonthly: 60, quarterly: 90, semiannual: 180, fallbackDays: 90 },
  clientQuestionText: { monthly: "Monthly prompt", bimonthly: "Bi-monthly prompt", quarterly: "Quarterly prompt", custom: "Custom prompt" },
  customerExplanationText: "Synthetic customer explanation.",
  calculationVersion: "1.0",
};

const scores = [
  { id: "score-1", service_record_id: "service-1", customer_id: "customer-1", customer_name: "Synthetic customer",
    service_date: "2026-09-10", service_line: "pest", calculated_score: 2.4, displayed_score: 2.4,
    label_name: "Moderate", trend: "stable", is_overridden: false },
  { id: "score-2", service_record_id: "service-2", customer_id: "customer-2", customer_name: "Override customer",
    service_date: "2026-09-09", service_line: "mosquito", calculated_score: 3.2, displayed_score: 4,
    label_name: "High", trend: "increasing", is_overridden: true, override_reason: "Synthetic override" },
];

const events = [{ id: "audit-1", action: "pest_pressure.override", actor_type: "admin", actor_id: "fixture-admin",
  created_at: "2026-09-11T12:00:00.000Z", metadata: { displayedScore: 4, reason: "Synthetic override" } }];

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function route(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  if (path === "/admin/pest-pressure/config") {
    return options.method === "PUT" ? { config: JSON.parse(options.body), changedFields: ["showComponentBreakdownToCustomer"] } : { config, defaults: config };
  }
  if (path === "/admin/pest-pressure/scores/recent?limit=25") return { scores };
  if (path === "/admin/pest-pressure/audit?limit=25") return { events };
  if (path === "/admin/pest-pressure/preview") return { result: { score: 2.6, label: { name: "Moderate" }, dataCompleteness: "complete",
    trend: "increasing", trendDelta: 0.5, summary: "Synthetic preview summary.", componentScores: {}, componentWeights: {}, missingComponents: [], calculationVersion: "1.0" } };
  if (path === "/admin/pest-pressure/scores/service-1/recalculate") return { ok: true };
  if (path === "/admin/pest-pressure/scores/service-1/override") return { ok: true };
  if (path === "/admin/pest-pressure/scores/service-2/override") return { ok: true };
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

function mount() {
  return render(<MemoryRouter initialEntries={["/admin/settings/pest-pressure"]}><PestPressureSettingsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(route(url, options))));
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pest Pressure settings new UI foundation", () => {
  it("renders the complete configuration, score table and audit log on shared primitives", async () => {
    const view = mount();
    expect(await screen.findByRole("table", { name: "Recent Pest Pressure scores" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pest pressure", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Score formula")).toBeInTheDocument();
    expect(screen.getByText("Client rating prompt text")).toBeInTheDocument();
    expect(screen.getByText("Synthetic customer")).toBeInTheDocument();
    expect(screen.getByText("pest_pressure.override")).toBeInTheDocument();
    expect(view.container.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();
    expect(view.container.querySelector("[style]:not(.ui-select)")).not.toBeInTheDocument();
  });

  it("preserves configuration and preview payloads", async () => {
    mount();
    await screen.findByText("Synthetic customer");
    fireEvent.click(screen.getByRole("switch", { name: "Show component breakdown to customers" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved. 1 field updated.");
    const saveCall = fetch.mock.calls.find(([url, options]) => url === "/api/admin/pest-pressure/config" && options?.method === "PUT");
    expect(JSON.parse(saveCall[1].body).showComponentBreakdownToCustomer).toBe(true);

    fireEvent.change(screen.getByLabelText("Client rating"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByText("Synthetic preview summary.")).toBeInTheDocument();
    const previewCall = fetch.mock.calls.find(([url, options]) => url === "/api/admin/pest-pressure/preview" && options?.method === "POST");
    expect(JSON.parse(previewCall[1].body).inputs.clientRating).toBe(4);
  });

  it("preserves recalculate and audited override actions", async () => {
    mount();
    await screen.findByText("Synthetic customer");
    fireEvent.click(screen.getAllByRole("button", { name: "Recalc" })[0]);
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) =>
      url === "/api/admin/pest-pressure/scores/service-1/recalculate" && options?.method === "POST"
      && options.body === JSON.stringify({ clearOverride: false }))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.getByRole("dialog", { name: "Override Pest Pressure score" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New displayed score (0–5)"), { target: { value: "3.7" } });
    fireEvent.change(screen.getByLabelText(/Reason \(required, audited\)/), { target: { value: "Corrected from technician notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) =>
      url === "/api/admin/pest-pressure/scores/service-1/override" && options?.method === "PUT"
      && options.body === JSON.stringify({ displayedScore: 3.7, reason: "Corrected from technician notes" }))).toBe(true));
  });

  it("shows load failures through shared feedback", async () => {
    fetch.mockImplementationOnce(async () => response({ error: "Synthetic config unavailable" }, 503));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load settings. Synthetic config unavailable");
  });
});
