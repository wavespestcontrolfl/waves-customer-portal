// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingLogicPanel from "./PricingLogicPanel";

const pricingConfig = {
  config_key: "global_adjustments",
  name: "Global adjustments",
  category: "global",
  data: { slopes: [{ label: "Flat", multiplier: 1 }] },
};

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function stubStorage(role = "admin") {
  vi.stubGlobal("localStorage", {
    getItem: (key) => key === "waves_admin_token"
      ? "synthetic-token"
      : key === "waves_admin_user"
        ? JSON.stringify({ role })
        : null,
  });
}

// Routes by URL prefix; anything not listed answers an empty success so the
// tab under test is the only request that can fail.
function stubFetch(routes) {
  const fetchMock = vi.fn(async (url) => {
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (key) return typeof routes[key] === "function" ? routes[key]() : routes[key];
    if (url.startsWith("/api/admin/pricing-config/audit-log")) return response({ logs: [] });
    if (url === "/api/admin/pricing-config") return response({ configs: [] });
    throw new Error(`Unexpected request: GET ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const openTab = async (name) => {
  render(<PricingLogicPanel />);
  fireEvent.click(await screen.findByRole("button", { name }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PricingLogicPanel load errors", () => {
  it("shows a 500 with a retry button instead of migration advice, and Try again loads the config", async () => {
    stubStorage();
    let failing = true;
    stubFetch({
      "/api/admin/pricing-config/audit-log": response({ logs: [] }),
      "/api/admin/pricing-config": () => failing
        ? response({ error: "Synthetic database failure" }, 500)
        : response({ configs: [pricingConfig] }),
    });

    render(<PricingLogicPanel />);
    expect(await screen.findByText("Could not load pricing configuration: Synthetic database failure")).toBeInTheDocument();
    expect(screen.queryByText(/Run the pricing_config migration/)).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Global adjustments")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load pricing configuration/)).not.toBeInTheDocument();
  });

  it("shows the message for a 401", async () => {
    stubStorage();
    stubFetch({
      "/api/admin/pricing-config/audit-log": response({ logs: [] }),
      "/api/admin/pricing-config": response({ error: "Session expired" }, 401),
    });

    render(<PricingLogicPanel />);
    expect(await screen.findByText("Could not load pricing configuration: Session expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reads the inventory API's camelCase fields on the Products tab", async () => {
    stubStorage("admin");
    stubFetch({
      "/api/admin/inventory": response({
        products: [{
          id: "p1", name: "Synthetic Product", category: "pest",
          activeIngredient: "Synthetic ingredient", bestPrice: 75, costPerUnit: 0.32, costUnit: "oz",
        }],
        total: 1,
      }),
    });

    await openTab("Products");
    const row = (await screen.findByText("Synthetic Product")).closest("tr");
    expect(row).toHaveTextContent("Synthetic ingredient");
    expect(row).toHaveTextContent("$75.00");
    expect(row).toHaveTextContent("$0.3200/oz");
    expect(screen.getByText("Unit cost")).toBeInTheDocument();
    expect(screen.getByText("1 products loaded. Full catalog available under Inventory tab.")).toBeInTheDocument();
  });

  it("tells a technician product costs are admin-only instead of an empty table", async () => {
    stubStorage("technician");
    stubFetch({
      "/api/admin/inventory": response({
        products: [{ id: "p1", name: "Synthetic Product", category: "pest", activeIngredient: "Synthetic ingredient" }],
        total: 1,
      }),
    });

    await openTab("Products");
    expect(await screen.findByText("Product costs are visible to admins only.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Synthetic Product")).not.toBeInTheDocument();
  });

  it("shows a lawn brackets failure instead of the migration text", async () => {
    stubStorage();
    stubFetch({ "/api/admin/pricing-config/lawn-brackets": response({ error: "Synthetic lawn failure" }, 500) });

    await openTab("Lawn");
    expect(await screen.findByText("Could not load lawn brackets: Synthetic lawn failure")).toBeInTheDocument();
    expect(screen.queryByText("No bracket data found. Run the pricing_config migration first.")).not.toBeInTheDocument();
  });

  it("shows a discount rules failure instead of the migration text", async () => {
    stubStorage();
    stubFetch({ "/api/admin/pricing-config/discount-rules": response({ error: "Synthetic rules failure" }, 500) });

    await openTab("WaveGuard");
    expect(await screen.findByText("Could not load discount rules: Synthetic rules failure")).toBeInTheDocument();
    expect(screen.queryByText(/No discount rules found/)).not.toBeInTheDocument();
  });

  it("shows a proposals failure instead of the empty state", async () => {
    stubStorage();
    stubFetch({ "/api/admin/pricing-proposals": response({ error: "Synthetic proposals failure" }, 500) });

    await openTab("Proposals");
    expect(await screen.findByText("Could not load proposals: Synthetic proposals failure")).toBeInTheDocument();
    expect(screen.queryByText("No pending proposals.")).not.toBeInTheDocument();
  });

  it("shows a changelog failure instead of the empty state", async () => {
    stubStorage();
    stubFetch({ "/api/admin/pricing-config/changelog": response({ error: "Synthetic changelog failure" }, 500) });

    await openTab("Changelog");
    await waitFor(() => expect(screen.getByText("Could not load the changelog: Synthetic changelog failure")).toBeInTheDocument());
    expect(screen.queryByText(/No changelog entries/)).not.toBeInTheDocument();
  });
});
