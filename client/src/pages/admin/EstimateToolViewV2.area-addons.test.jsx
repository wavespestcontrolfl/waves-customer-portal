// @vitest-environment jsdom
// Area add-on treatments (GATE_AREA_ADDONS) on the staff estimator. The group
// is dark: it renders only when the lawn_pricing_v2 read says `areaAddOns.enabled`,
// takes its rows from that catalog (never from a table in the client), and sends
// `options.areaAddOns = [{ key, areaSqFt }]` plus one `options.areaAddOnVisit` — or nothing — on the
// calculate request. Pre-fill picks the smallest tier that holds the area the
// estimator already knows and never overwrites a tier the rep chose.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "500 Example Court, Venice, FL 34285";

// A catalog in the server's shape. The names are the server's to change; the
// tests read whatever this payload says.
const ITEMS = [
  { key: "bed_pre_emergent", name: "Bed Pre-Emergent Weed Control", category: "lawn_care", areaLabel: "bed", tiers: [1000, 2000, 3500], maxPerYear: 2, requiresGrassTrack: null },
  { key: "lawn_insect_spot", name: "Lawn Insect Spot Treatment", category: "lawn_care", areaLabel: "treated lawn", tiers: [1000, 2000, 3500], maxPerYear: 2, requiresGrassTrack: "st_augustine" },
  { key: "fire_ant_yard", name: "Fire Ant Yard Treatment", category: "lawn_care", areaLabel: "lawn", tiers: [3000, 5000, 8000], maxPerYear: 1, requiresGrassTrack: null },
  { key: "lawn_insect_preventive", name: "Yearly Lawn Insect Preventive", category: "lawn_care", areaLabel: "lawn", tiers: [3000, 5000, 8000], maxPerYear: 1, requiresGrassTrack: null },
  { key: "hardscape_weed", name: "Shell, Rock & Paver Weed Control", category: "lawn_care", areaLabel: "treated", tiers: [1000, 2000, 3500], maxPerYear: 2, requiresGrassTrack: null },
  { key: "web_sweep", name: "Web Sweep", category: "pest_control", areaLabel: null, tiers: null, maxPerYear: 12, requiresGrassTrack: null },
];
const catalog = (enabled = true, items = ITEMS) => ({ enabled, visitContexts: ["standalone", "sameTripAddOn"], items });

const pestLine = { service: "pest_control", name: "Pest Control", mo: 50, annual: 600 };
const RESULT = {
  recurring: { tier: "Bronze", grandTotal: 50, annualAfterDiscount: 600, services: [pestLine] },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400, status, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let areaAddOns;
let lookupEnriched;
let calculateReply;
let editSource;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  areaAddOns = catalog();
  lookupEnriched = { homeSqFt: 2000, lotSqFt: 9000, stories: 1 };
  calculateReply = null;
  editSource = null;
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.includes("/admin/pricing-config/lawn_pricing_v2")) {
      return Promise.resolve(jsonResponse(areaAddOns === undefined ? {} : { areaAddOns }));
    }
    if (path.endsWith("/estimator/property-lookup")) {
      return Promise.resolve(jsonResponse({ enriched: structuredClone(lookupEnriched), errors: [] }));
    }
    if (path.endsWith("/calculate-estimate")) {
      return calculateReply ? calculateReply() : Promise.resolve(jsonResponse(structuredClone(RESULT)));
    }
    if (path.endsWith("/edit-source")) return Promise.resolve(jsonResponse(structuredClone(editSource)));
    if (path.includes("/discounts")) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const calculateBodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith("/calculate-estimate"))
  .map(([, init]) => JSON.parse(init.body));

function renderNew(props = {}) {
  return render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} {...props} /></MemoryRouter>);
}

async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}

async function openGroup() {
  const group = await screen.findByTestId("area-addons-group");
  if (!within(group).queryByRole("checkbox")) fireEvent.click(within(group).getByRole("button", { name: "Show" }));
  return group;
}

const box = (name) => screen.getByRole("checkbox", { name });
async function generate() {
  const before = calculateBodies().length;
  fireEvent.click(screen.getByRole("button", { name: /^(Generate Estimate|Regenerate)$/ }));
  await waitFor(() => expect(calculateBodies().length).toBe(before + 1));
  return calculateBodies()[before];
}

describe("add-on treatments group: availability and catalog", () => {
  it("stays hidden while the server says the add-ons are off (or sends no add-on block)", async () => {
    areaAddOns = catalog(false);
    const { unmount } = renderNew();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("lawn_pricing_v2"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Add-on treatments")).not.toBeInTheDocument();
    unmount();

    areaAddOns = undefined;
    renderNew();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("lawn_pricing_v2"))).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Add-on treatments")).not.toBeInTheDocument();
  });

  it("builds its rows from the catalog payload, not from a table in the client", async () => {
    areaAddOns = catalog(true, [
      { key: "bed_pre_emergent", name: "Server-Named Bed Job", category: "lawn_care", areaLabel: "bed", tiers: [500, 900], maxPerYear: 3, requiresGrassTrack: null },
      { key: "web_sweep", name: "Server-Named Sweep", category: "pest_control", areaLabel: null, tiers: null, maxPerYear: 12, requiresGrassTrack: null },
    ]);
    renderNew();
    const group = await openGroup();
    expect(within(group).getAllByRole("checkbox").map((el) => el.closest("label").textContent))
      .toEqual(["Server-Named Bed Job", "Server-Named Sweep"]);
    fireEvent.click(box("Server-Named Bed Job"));
    const tier = screen.getByLabelText("Bed area");
    expect(within(tier).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Up to 500 sq ft", "Up to 900 sq ft", "Larger: manual quote"]);
    expect(screen.getByText("Label limit: 3 a year")).toBeInTheDocument();
    // A flat job takes no area and shows no area select.
    fireEvent.click(box("Server-Named Sweep"));
    expect(document.getElementById("estimate-areaAddOn-web_sweep-tier")).toBeNull();
    // The visit is one select for the group, not one per row.
    expect(document.getElementById("estimate-areaAddOn-web_sweep-visit")).toBeNull();
    expect(document.getElementById("estimate-areaAddOns-visit")).not.toBeNull();
  });
});

describe("what a checked row sends", () => {
  it("sends nothing when no add-on is checked", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    const body = await generate();
    expect("areaAddOns" in body.options).toBe(false);
  });

  it("sends one entry per key: tier ceiling as the area, no area for a flat job, and ONE group visit", async () => {
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 450 };
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    fireEvent.click(box("Bed Pre-Emergent Weed Control"));
    fireEvent.click(box("Web Sweep"));
    // One Visit select for the whole group, not one per row.
    expect(screen.getAllByLabelText("Visit")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Visit"), { target: { value: "sameTripAddOn" } });
    const body = await generate();
    expect(body.options.areaAddOns).toEqual([
      { key: "bed_pre_emergent", areaSqFt: 1000 },
      { key: "web_sweep" },
    ]);
    expect(body.options.areaAddOnVisit).toBe("sameTripAddOn");
    expect(JSON.stringify(body.options.areaAddOns)).not.toMatch(/applications|visitContext/);
  });

  it("makes an add-on count as a selected service, so Generate works with only an add-on", async () => {
    renderNew();
    await openGroup();
    expect(screen.getByText("Select at least one service to see pricing")).toBeInTheDocument();
    fireEvent.click(box("Web Sweep"));
    expect(screen.getByText(/1 one-time selected/)).toBeInTheDocument();
  });

  it("shows the server's message when the calculate call is refused", async () => {
    const message = "Add-ons on the same visit need a priced service on the same estimate (a recurring service or another one-time service); price them as their own visit or add the service they ride with";
    calculateReply = () => Promise.resolve(jsonResponse({ error: message }, 400));
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    fireEvent.click(box("Web Sweep"));
    fireEvent.change(screen.getByLabelText("Visit"), { target: { value: "sameTripAddOn" } });
    await generate();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(`Estimate calculation failed: ${message}`));
  });
});

describe("add-on-only quotes need no property data (Codex round 5 P2)", () => {
  it.each([
    ["a web sweep", "Web Sweep", { key: "web_sweep" }],
    ["a tiered add-on", "Fire Ant Yard Treatment", { key: "fire_ant_yard", areaSqFt: 3000 }],
  ])("generates %s alone with no property lookup, home size or lot size", async (_label, name, entry) => {
    renderNew();
    await openGroup();
    fireEvent.click(box(name));
    const body = await generate();
    expect(window.alert).not.toHaveBeenCalled();
    expect(body.selectedServices).toEqual([]);
    expect(body.profile).toMatchObject({ homeSqFt: 0, lotSqFt: 0 });
    expect(body.options.areaAddOns).toEqual([entry]);
    expect(body.options.areaAddOnVisit).toBe("standalone");
  });

  it("still asks for a home or lot size when a footprint-priced service is selected beside the add-on", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(screen.getByRole("button", { name: /^(Generate Estimate|Regenerate)$/ }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Enter home sq ft or lot size."));
    expect(calculateBodies()).toHaveLength(0);
  });

  it("an unchecked add-on leaves the footprint gate as it was", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(screen.getByRole("button", { name: /^(Generate Estimate|Regenerate)$/ }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Enter home sq ft or lot size."));
    expect(calculateBodies()).toHaveLength(0);
  });
});

describe("same-visit choice", () => {
  it("appears once, only while an add-on is selected, and applies to every add-on", async () => {
    renderNew();
    await openGroup();
    expect(screen.queryByLabelText("Visit")).not.toBeInTheDocument();
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(box("Fire Ant Yard Treatment"));
    expect(screen.getAllByLabelText("Visit")).toHaveLength(1);
    expect(screen.getByText("All selected add-ons share this visit.")).toBeInTheDocument();
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(box("Fire Ant Yard Treatment"));
    expect(screen.queryByLabelText("Visit")).not.toBeInTheDocument();
  });

  it("an add-on is never the service the group rides with: two add-ons and no service still show the hint", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(box("Fire Ant Yard Treatment"));
    fireEvent.change(screen.getByLabelText("Visit"), { target: { value: "sameTripAddOn" } });
    expect(screen.getByText("Needs another service on this estimate")).toBeInTheDocument();
  });

  it("stays selectable with no other service, shows a hint, and drops it once a service is picked", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(box("Web Sweep"));
    fireEvent.change(screen.getByLabelText("Visit"), { target: { value: "sameTripAddOn" } });
    expect(screen.getByLabelText("Visit")).toHaveValue("sameTripAddOn");
    expect(screen.getByText("Needs another service on this estimate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    expect(screen.queryByText("Needs another service on this estimate")).not.toBeInTheDocument();
  });
});

describe("tier pre-fill", () => {
  it("picks the smallest tier that holds the known bed and lawn areas, and says where the number came from", async () => {
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 1450, estimatedTurfSf: 4200 };
    renderNew();
    await openGroup();
    await lookUp();
    fireEvent.click(box("Bed Pre-Emergent Weed Control"));
    expect(screen.getByLabelText("Bed area")).toHaveValue("2000");
    expect(screen.getByText(/Property lookup: about 1,450 sq ft of beds\. Change it if the beds are larger\./)).toBeInTheDocument();
    fireEvent.click(box("Fire Ant Yard Treatment"));
    fireEvent.click(box("Yearly Lawn Insect Preventive"));
    const lawnSelects = screen.getAllByLabelText("Lawn area");
    expect(lawnSelects.map((el) => el.value)).toEqual(["5000", "5000"]);
    expect(screen.getAllByText(/about 4,200 sq ft of lawn/)).toHaveLength(2);
  });

  it("does not pre-fill the two judgment add-ons: they start at the smallest tier", async () => {
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 1450, estimatedTurfSf: 4200 };
    renderNew();
    await openGroup();
    await lookUp();
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    fireEvent.click(box("Shell, Rock & Paver Weed Control"));
    expect(screen.getByLabelText("Treated lawn area")).toHaveValue("1000");
    expect(screen.getByLabelText("Treated area")).toHaveValue("1000");
    expect(screen.queryByText(/Property lookup:/)).not.toBeInTheDocument();
  });

  it("selects the manual-quote choice and sends the real area when the known area is above the largest tier", async () => {
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 5200 };
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    fireEvent.click(box("Bed Pre-Emergent Weed Control"));
    expect(screen.getByLabelText("Bed area")).toHaveValue("larger");
    expect(screen.getByLabelText("Bed area (sq ft)")).toHaveValue(5200);
    const body = await generate();
    expect(body.options.areaAddOns).toEqual([{ key: "bed_pre_emergent", areaSqFt: 5200 }]);
  });

  it("never overwrites a tier the rep chose", async () => {
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 450 };
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tree & Shrub", exact: true }));
    await lookUp();
    fireEvent.click(box("Bed Pre-Emergent Weed Control"));
    fireEvent.change(screen.getByLabelText("Bed area"), { target: { value: "3500" } });
    // The known area changes afterwards; the rep's tier stands.
    fireEvent.change(screen.getByLabelText("Bed Area (sq ft)"), { target: { value: "300" } });
    expect(screen.getByText(/Bed area entered: about 300 sq ft of beds/)).toBeInTheDocument();
    expect(screen.getByLabelText("Bed area")).toHaveValue("3500");
  });
});

describe("notes and the grass track", () => {
  it("shows the label limit, the grass-only note and the hard-surface note", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    fireEvent.click(box("Shell, Rock & Paver Weed Control"));
    expect(screen.getAllByText("Label limit: 2 a year").length).toBeGreaterThan(0);
    expect(screen.getByText("Hard surfaces and bare ground only. Keep off lawn, beds and root zones.")).toBeInTheDocument();
    expect(screen.getByText("St. Augustine only. Other grass becomes a manual quote.")).toBeInTheDocument();
    expect(screen.getByText("Choose the grass to price this. Until then it is a manual quote.")).toBeInTheDocument();
  });
});

describe("a grass-bound add-on takes its own grass (Codex round 5 P1)", () => {
  const GRASS_ROW = "#estimate-areaAddOn-lawn_insect_spot-grass";
  const grassSelect = () => document.querySelector(GRASS_ROW);
  const spotEntry = (body) => body.options.areaAddOns.find((entry) => entry.key === "lawn_insect_spot");

  it("shows a required Grass select with no default, only on the row whose price is bound to a grass", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    fireEvent.click(box("Fire Ant Yard Treatment"));
    expect(grassSelect()).toBeRequired();
    expect(grassSelect()).toHaveValue("");
    expect(within(grassSelect()).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Choose the grass", "St. Augustine / Floratam", "Bermuda", "Zoysia", "Bahia"]);
    expect(document.getElementById("estimate-areaAddOn-fire_ant_yard-grass")).toBeNull();
  });

  it("sends an explicit unknown grass until the rep chooses, even with Lawn Care and its default grass selected", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Lawn Care", exact: true }));
    await lookUp();
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    const body = await generate();
    // The estimate's own grass is the untouched default; the add-on never takes it.
    expect(body.options.grassType).toBe("st_augustine");
    expect(spotEntry(body)).toEqual({ key: "lawn_insect_spot", areaSqFt: 1000, grassType: "unknown" });
    expect(grassSelect()).toHaveValue("");
  });

  it("sends the grass the rep chose on the row and keeps it", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    fireEvent.change(grassSelect(), { target: { value: "bermuda" } });
    expect(grassSelect()).toHaveValue("bermuda");
    expect(within(grassSelect()).queryByRole("option", { name: "Choose the grass" })).toBeNull();
    expect(spotEntry(await generate()).grassType).toBe("bermuda");
    fireEvent.change(grassSelect(), { target: { value: "st_augustine" } });
    expect(spotEntry(await generate()).grassType).toBe("st_augustine");
  });

  it("starts the row on a grass the rep chose elsewhere on the screen and says where it came from; the untouched default never does", async () => {
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Lawn Care", exact: true }));
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    expect(grassSelect()).toHaveValue("");
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    fireEvent.change(await screen.findByLabelText("Grass Type / Track"), { target: { value: "bermuda" } });
    fireEvent.click(box("Lawn Insect Spot Treatment"));
    expect(grassSelect()).toHaveValue("bermuda");
    expect(screen.getByText("From the Grass Type / Track box on this screen. Change it here if the grass differs.")).toBeInTheDocument();
    fireEvent.change(grassSelect(), { target: { value: "zoysia" } });
    expect(screen.queryByText(/From the Grass Type \/ Track box/)).not.toBeInTheDocument();
  });

  it("reloads a saved estimate with its chosen grass, and an unchosen one as not chosen", async () => {
    editSource = {
      id: "qa-grass-estimate", status: "draft", editable: true, editVersion: "qa-version",
      customerName: "QA Contact", address: ADDRESS, result: RESULT,
      inputs: { svcPest: true, homeSqFt: "2000", lotSqFt: "9000", stories: "1" },
      engineRequest: { profile: {}, selectedServices: ["PEST"], options: { areaAddOns: [{ key: "lawn_insect_spot", areaSqFt: 1000, grassType: "unknown" }], areaAddOnVisit: "standalone" } },
    };
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-grass-estimate" /></MemoryRouter>);
    await screen.findByTestId("area-addons-group");
    expect(grassSelect()).toHaveValue("");
    expect(spotEntry(await generate()).grassType).toBe("unknown");
  });
});

describe("saved estimates", () => {
  const SAVED_LIST = [
    { key: "fire_ant_yard", areaSqFt: 5000 },
    { key: "web_sweep" },
  ];
  function reopen(editFields) {
    editSource = {
      id: "qa-addon-estimate", status: "draft", editable: true, editVersion: "qa-version",
      customerName: "QA Contact", address: ADDRESS, result: RESULT, ...editFields,
    };
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-addon-estimate" /></MemoryRouter>);
  }

  it("reloads the add-ons from the stored engine request when the form snapshot has none", async () => {
    reopen({
      inputs: { svcPest: true, homeSqFt: "2000", lotSqFt: "9000", stories: "1" },
      engineRequest: { profile: {}, selectedServices: ["PEST"], options: { areaAddOns: SAVED_LIST, areaAddOnVisit: "sameTripAddOn" } },
    });
    const group = await screen.findByTestId("area-addons-group");
    expect(within(group).getByText("2 selected")).toBeInTheDocument();
    expect(box("Fire Ant Yard Treatment")).toBeChecked();
    expect(box("Web Sweep")).toBeChecked();
    expect(screen.getByLabelText("Lawn area")).toHaveValue("5000");
    expect(screen.getByLabelText("Visit")).toHaveValue("sameTripAddOn");
    const body = await generate();
    expect(body.options.areaAddOns).toEqual(SAVED_LIST);
    expect(body.options.areaAddOnVisit).toBe("sameTripAddOn");
  });

  it("reloads an estimate saved with a visit on each add-on: same visit only when every add-on had it", async () => {
    reopen({
      inputs: { svcPest: true, homeSqFt: "2000", lotSqFt: "9000", stories: "1" },
      engineRequest: { profile: {}, selectedServices: ["PEST"], options: { areaAddOns: [{ key: "fire_ant_yard", areaSqFt: 5000, visitContext: "sameTripAddOn" }, { key: "web_sweep", visitContext: "standalone" }] } },
    });
    await screen.findByTestId("area-addons-group");
    expect(screen.getByLabelText("Visit")).toHaveValue("standalone");
    expect(JSON.stringify((await generate()).options.areaAddOns)).not.toMatch(/visitContext/);
  });

  it("reloads the form snapshot the builder saved", async () => {
    reopen({
      inputs: {
        svcPest: true, homeSqFt: "2000", lotSqFt: "9000", stories: "1",
        areaAddOns: { bed_pre_emergent: { areaSqFt: "2000", larger: false } },
        areaAddOnVisit: "sameTripAddOn",
      },
    });
    await screen.findByTestId("area-addons-group");
    expect(box("Bed Pre-Emergent Weed Control")).toBeChecked();
    expect(screen.getByLabelText("Bed area")).toHaveValue("2000");
    expect(screen.getByLabelText("Visit")).toHaveValue("sameTripAddOn");
  });

  it("keeps a saved add-on visible with a note while the add-ons are off, and lets the rep uncheck it", async () => {
    areaAddOns = catalog(false);
    reopen({
      inputs: { svcPest: true, homeSqFt: "2000", lotSqFt: "9000", stories: "1" },
      engineRequest: { profile: {}, selectedServices: ["PEST"], options: { areaAddOns: SAVED_LIST } },
    });
    const group = await screen.findByTestId("area-addons-group");
    expect(await within(group).findAllByText("Add-on treatments are currently unavailable. Uncheck this one to calculate.")).toHaveLength(2);
    expect(within(group).queryByLabelText("Visit")).not.toBeInTheDocument();
    // The selection is still forwarded: the server's gate refuses it loudly.
    const body = await generate();
    expect(body.options.areaAddOns).toHaveLength(2);
    fireEvent.click(box("Web Sweep"));
    fireEvent.click(box("Fire Ant Yard Treatment"));
    await waitFor(() => expect(screen.queryByTestId("area-addons-group")).not.toBeInTheDocument());
  });
});

describe("preview rows", () => {
  it("renders priced and custom-quote add-on rows with their own name, detail and price", async () => {
    calculateReply = () => Promise.resolve(jsonResponse({
      ...RESULT,
      hasOneTime: true,
      isRecurringCustomer: true,
      oneTime: {
        total: 129, otSubtotal: 129,
        items: [{
          service: "area_addon", addOnKey: "fire_ant_yard", name: "Fire Ant Yard Treatment", price: 129,
          detail: "Up to 5,000 sq ft lawn area | Own visit", tierSqFt: 5000, visitContext: "standalone", discountable: false,
        }],
        specItems: [{
          service: "area_addon", addOnKey: "bed_pre_emergent", name: "Bed Pre-Emergent Weed Control", price: null,
          quoteRequired: true, requiresCustomQuote: true, customQuoteReason: "area_addon_area_above_largest_tier",
        }],
      },
      specItems: [{
        service: "area_addon", addOnKey: "bed_pre_emergent", name: "Bed Pre-Emergent Weed Control", price: null,
        quoteRequired: true, requiresCustomQuote: true, customQuoteReason: "area_addon_area_above_largest_tier",
      }],
    }));
    renderNew();
    await openGroup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
    await lookUp();
    await generate();
    expect((await screen.findAllByText("Fire Ant Yard Treatment")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Up to 5,000 sq ft lawn area | Own visit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Own visit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$129").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Quote Required").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/larger than our standard add-on sizes/).length).toBeGreaterThan(0);
    // An add-on carries no recurring-customer perk, so no -15% badge on its card.
    expect(screen.queryByText("-15%")).not.toBeInTheDocument();
  });
});
