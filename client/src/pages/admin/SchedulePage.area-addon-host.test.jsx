// @vitest-environment jsdom
// Round 7 P1 on #6135: only an appointment whose OWN service is an area add-on takes the generic
// completion lane. A normal lawn or pest visit with add-on rows attached keeps its full lane and
// gains the add-on's product fields beside it (AreaAddOnFields), while the lightweight shortcuts
// stay off for it.
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { CompletionPanel } from "./SchedulePage";
import { isLawnFastCompleteEligible } from "../../lib/lawn-fast-complete";
import { isFastCompleteReportEligible } from "../../lib/pest-fast-complete";
import { areaAddOnRowServiceType, hostAreaAddOns, soldAreaText } from "../../lib/areaAddOns";

const topchoice = { id: "prod-topchoice", name: "Topchoice", category: "insecticide", application_method: "granular_broadcast", rate_unit: "lb", default_rate_per_1000: 2 };
const catalog = [topchoice, { id: "prod-other", name: "Test general product", category: "insecticide", application_method: "perimeter_spray" }];

const fireAnt = { key: "area_addon_fire_ant_yard", name: "Fire Ant Yard Treatment", areaSqFt: 4200, tierSqFt: 5000, areaLabel: "lawn", grassType: null };
const sweep = { key: "area_addon_web_sweep", name: "Web Sweep", areaSqFt: null, tierSqFt: null, areaLabel: null, grassType: null };
const attached = (addOns) => ({ areaAddOnRowsAttached: true, areaAddOnKeys: addOns.map((a) => a.key), areaAddOns: addOns });

const lawnHost = { id: "host-lawn", customerId: "c1", customerName: "Synthetic Customer", serviceType: "Lawn Care", status: "on_site", scheduledDate: "2099-01-01", completionProfile: { serviceKey: "lawn", category: "lawn_care", requiresProducts: false }, lawnFastCompleteEnabled: true };
const pestHost = { id: "host-pest", customerId: "c1", customerName: "Synthetic Customer", serviceType: "Pest Control", status: "on_site", scheduledDate: "2099-01-01", completionProfile: { serviceKey: "pest_general_quarterly", category: "pest_control", requiresProducts: false }, fastCompleteReportEnabled: true };
const addOnAsPrimary = { id: "visit-addon", customerId: "c1", customerName: "Synthetic Customer", serviceType: "Fire Ant Yard Treatment", status: "on_site", scheduledDate: "2099-01-01", completionProfile: { serviceKey: "area_addon_fire_ant_yard", category: "lawn_care", requiresProducts: false } };

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes("lawn-assessment/service") ? { assessment: null } : { customer: {}, actions: [], available: false }),
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

async function mount(service, width = 1024) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  await act(async () => { render(<CompletionPanel service={service} products={catalog} onClose={() => {}} onSubmit={vi.fn()} />); });
}
const blockText = () => screen.getByTestId("area-addon-fields");

describe("which lane a visit with add-ons takes", () => {
  it("an appointment whose own service is the add-on is generic: no lawn assessment, no add-on block", async () => {
    await mount({ ...addOnAsPrimary, ...attached([fireAnt]) });
    expect(screen.queryByText("Lawn Assessment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("area-addon-fields")).not.toBeInTheDocument();
    expect(hostAreaAddOns({ ...addOnAsPrimary, ...attached([fireAnt]) })).toEqual([]);
  });

  it("a lawn host with an add-on keeps the full lawn form and gains the add-on fields", async () => {
    await mount({ ...lawnHost, ...attached([fireAnt]) });
    expect(screen.getByText("Lawn Assessment")).toBeInTheDocument();
    expect(within(blockText()).getByText("Fire Ant Yard Treatment")).toBeInTheDocument();
    expect(within(blockText()).getByText("Sold: up to 5,000 sq ft of lawn area")).toBeInTheDocument();
  });

  it("a lawn host with no add-on shows no add-on block, as before", async () => {
    await mount(lawnHost);
    expect(screen.getByText("Lawn Assessment")).toBeInTheDocument();
    expect(screen.queryByTestId("area-addon-fields")).not.toBeInTheDocument();
  });

  it("the lightweight shortcuts stay off for a host with add-on rows, and on for the same host without", () => {
    expect(isLawnFastCompleteEligible(lawnHost)).toBe(true);
    expect(isLawnFastCompleteEligible({ ...lawnHost, ...attached([fireAnt]) })).toBe(false);
    expect(isFastCompleteReportEligible(pestHost)).toBe(true);
    expect(isFastCompleteReportEligible({ ...pestHost, ...attached([sweep]) })).toBe(false);
  });
});

describe("the add-on's product on a host visit", () => {
  it("a pest host with a web sweep keeps the pest form and records no product for the sweep", async () => {
    await mount({ ...pestHost, ...attached([sweep]) });
    expect(screen.queryByText("Lawn Assessment")).not.toBeInTheDocument();
    expect(within(blockText()).getByText("Web Sweep")).toBeInTheDocument();
    expect(within(blockText()).getByText("No product to record for this add-on.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Product used for Web Sweep")).not.toBeInTheDocument();
    expect(screen.getByText("Products Applied")).toBeInTheDocument();
  });

  it("a pest host with a chemical lawn add-on asks for the treated square feet on the add-on's product only", async () => {
    await mount({ ...pestHost, ...attached([fireAnt]) });
    expect(screen.queryByPlaceholderText("Sq ft")).not.toBeInTheDocument();
    expect(within(blockText()).getByText("Product not recorded yet. Choose the product you used for this add-on.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Product used for Fire Ant Yard Treatment"), { target: { value: topchoice.id } });
    // The product is recorded in the visit's ordinary list, tagged with the add-on, lawn rules on that row.
    expect(within(blockText()).getByText(/^Recorded: Topchoice\./)).toBeInTheDocument();
    expect(await screen.findByPlaceholderText("Sq ft")).toBeInTheDocument();
  });

  it("the same product added through the ordinary picker on a pest host keeps the pest rules (no square feet)", async () => {
    await mount(pestHost);
    fireEvent.change(screen.getByPlaceholderText("Search products..."), { target: { value: "Topchoice" } });
    fireEvent.click(await screen.findByText("Topchoice"));
    expect(screen.getByText("Topchoice")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Sq ft")).not.toBeInTheDocument();
  });

  it("the mobile form renders the same add-on fields", async () => {
    await mount({ ...lawnHost, ...attached([fireAnt]) }, 400);
    expect(within(blockText()).getByText("Sold: up to 5,000 sq ft of lawn area")).toBeInTheDocument();
  });
});

describe("the row type and label helpers", () => {
  it("an add-on visit is lawn-family for a chemical add-on and the host's own for the sweep", () => {
    expect(areaAddOnRowServiceType(addOnAsPrimary, "Fire Ant Yard Treatment", null)).toBe("Lawn Care");
    expect(areaAddOnRowServiceType({ completionProfile: { serviceKey: "area_addon_web_sweep" } }, "Web Sweep", null)).toBe("Web Sweep");
  });

  it("on a host only a row tagged with a chemical add-on is lawn-family", () => {
    const host = { ...pestHost, ...attached([fireAnt, sweep]) };
    expect(areaAddOnRowServiceType(host, "Pest Control", { areaAddOnKey: fireAnt.key })).toBe("Lawn Care");
    expect(areaAddOnRowServiceType(host, "Pest Control", { areaAddOnKey: sweep.key })).toBe("Pest Control");
    expect(areaAddOnRowServiceType(host, "Pest Control", {})).toBe("Pest Control");
    expect(areaAddOnRowServiceType(host, "Pest Control", null)).toBe("Pest Control");
  });

  it("the sold text names the tier first, then the area, and is null with neither", () => {
    expect(soldAreaText(fireAnt)).toBe("Sold: up to 5,000 sq ft of lawn area");
    expect(soldAreaText({ areaSqFt: 900, areaLabel: "bed" })).toBe("Sold: about 900 sq ft of bed area");
    expect(soldAreaText(sweep)).toBeNull();
  });
});
