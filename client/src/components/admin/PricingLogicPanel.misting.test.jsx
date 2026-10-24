// @vitest-environment jsdom
// The panel lists every pricing_config row by category, so the mosquito misting row
// (mosquito_misting_pricing, category "mosquito") needs no panel code of its own. This pins
// that it shows under the Mosquito tab and that the server's strict validation message
// reaches the operator when an edit is refused.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PricingLogicPanel from "./PricingLogicPanel";

const mistingRow = {
  config_key: "mosquito_misting_pricing",
  name: "Mosquito Misting System Pricing",
  category: "mosquito",
  data: { extraNozzlePrice: 75, plan: { monthly: 59 } },
};
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key) => key === "waves_admin_token"
      ? "synthetic-token"
      : key === "waves_admin_user" ? JSON.stringify({ role: "admin" }) : null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PricingLogicPanel mosquito misting row", () => {
  it("shows the row only under Mosquito and surfaces the server's validation error on save", async () => {
    const message = "mosquito_misting_pricing: plan.monthly must be a number between 1 and 500";
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url === "/api/admin/pricing-config") return response({ configs: [mistingRow] });
      if (url === "/api/admin/pricing-config/mosquito_misting_pricing" && options.method === "PUT") return response({ error: message }, 400);
      if (String(url).includes("audit-log")) return response({ logs: [] });
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PricingLogicPanel />);
    await screen.findByRole("button", { name: "Mosquito" });
    expect(screen.queryByText("Mosquito Misting System Pricing")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mosquito" }));
    fireEvent.click(await screen.findByText("Mosquito Misting System Pricing"));
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    fireEvent.change(screen.getByLabelText("Configuration JSON"), { target: { value: '{"extraNozzlePrice":75,"plan":{"monthly":9999}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(`Save failed: ${message}`)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, o]) => o?.method === "PUT")).toHaveLength(1));
    expect(JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === "PUT")[1].body))
      .toEqual({ data: { extraNozzlePrice: 75, plan: { monthly: 9999 } } });
    // The refused draft stays open for correction.
    expect(screen.getByLabelText("Configuration JSON")).toBeInTheDocument();
  });
});
