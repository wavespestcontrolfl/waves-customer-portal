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
import pageSource from "./SchedulePage.jsx?raw";
import { isLawnFastCompleteEligible } from "../../lib/lawn-fast-complete";
import { isFastCompleteReportEligible } from "../../lib/pest-fast-complete";
import { areaAddOnRowServiceType, hostAreaAddOns, soldAreaText } from "../../lib/areaAddOns";

const topchoice = { id: "prod-topchoice", name: "Topchoice", category: "insecticide", application_method: "granular_broadcast", rate_unit: "lb", default_rate_per_1000: 2 };
const catalog = [topchoice, { id: "prod-other", name: "Test general product", category: "insecticide", application_method: "perimeter_spray" }];

const fireAnt = { key: "area_addon_fire_ant_yard", name: "Fire Ant Yard Treatment", areaSqFt: 4200, tierSqFt: 5000, areaLabel: "lawn", grassType: null, governed: { ratePer1000: 2, rateUnit: "lb", productName: "Topchoice Granular Insecticide", productId: "prod-topchoice", withheld: "The label rate is not verified yet." } };
const sweep = { key: "area_addon_web_sweep", name: "Web Sweep", areaSqFt: null, tierSqFt: null, areaLabel: null, grassType: null };
const bed = { key: "area_addon_bed_pre_emergent", name: "Bed Pre-Emergent Weed Control", areaSqFt: 900, tierSqFt: 1000, areaLabel: "bed", grassType: null };
const attached = (addOns) => ({ areaAddOnRowsAttached: true, areaAddOns: addOns });

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
    await mount(addOnAsPrimary);
    expect(screen.queryByText("Lawn Assessment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("area-addon-fields")).not.toBeInTheDocument();
    expect(hostAreaAddOns(addOnAsPrimary)).toEqual([]);
  });

  it("an appointment whose own service is one add-on still gets product fields for the OTHER add-ons attached to it (Codex round 8)", async () => {
    const service = { ...addOnAsPrimary, ...attached([bed]) };
    await mount(service);
    // The visit's own add-on is recorded in the generic list; the attached one has its own fields and tag.
    expect(screen.queryByText("Lawn Assessment")).not.toBeInTheDocument();
    expect(within(blockText()).getByText("Bed Pre-Emergent Weed Control")).toBeInTheDocument();
    expect(within(blockText()).queryByText("Fire Ant Yard Treatment")).not.toBeInTheDocument();
    expect(hostAreaAddOns(service)).toEqual([bed]);
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

// Codex round 9 P1 on #6135: a Tree & Shrub visit with Snapshot AND a Bed Pre-Emergent add-on (also Snapshot) made one
// product-id keyed list: the add-on's row replaced the host's, and closeout stayed pending on an untagged host row.
describe("a host row and an add-on row of the SAME product are two rows", () => {
  const snapshot = { id: "prod-snapshot", name: "Snapshot 2.5TG", category: "herbicide", application_method: "granular_broadcast", rate_unit: "lb", default_rate_per_1000: 3.45 };
  // The Tree & Shrub sheet has its own typed lane; the product list under test is the shared one every other host uses.
  const tsHost = pestHost;
  const bedAddOn = { ...bed, governed: { ratePer1000: 3.45, rateUnit: "lb", productId: "prod-snapshot", productName: "Snapshot 2.5TG", withheld: null } };
  async function mountTs(service = { ...tsHost, ...attached([bedAddOn]) }) {
    await act(async () => { render(<CompletionPanel service={service} products={[snapshot, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
  }
  const addHostSnapshot = async () => {
    fireEvent.change(screen.getByPlaceholderText("Search products..."), { target: { value: "Snapshot" } });
    // (the add-on's own picker lists Snapshot too: the search result is the one that is not an <option>)
    fireEvent.click((await screen.findAllByText("Snapshot 2.5TG")).find((el) => el.tagName !== "OPTION"));
  };
  const addAddOnSnapshot = () => fireEvent.change(screen.getByLabelText("Product used for Bed Pre-Emergent Weed Control"), { target: { value: snapshot.id } });

  it("the add-on's Snapshot after the host's keeps BOTH rows", async () => {
    await mountTs();
    await addHostSnapshot();
    expect(screen.getAllByLabelText("Remove product")).toHaveLength(1);
    addAddOnSnapshot();
    expect(await within(blockText()).findByText(/^Recorded: Snapshot 2\.5TG\./)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove product")).toHaveLength(2);
  });

  it("the host's Snapshot after the add-on's keeps BOTH rows (the picker is not blocked by the tagged row)", async () => {
    await mountTs();
    addAddOnSnapshot();
    expect(await within(blockText()).findByText(/^Recorded: Snapshot 2\.5TG\./)).toBeInTheDocument();
    await addHostSnapshot();
    expect(screen.getAllByLabelText("Remove product")).toHaveLength(2);
  });

  it("removing the host's row leaves the add-on's (and the add-on stays recorded), and removing the add-on's leaves the host's", async () => {
    await mountTs();
    await addHostSnapshot();
    addAddOnSnapshot();
    await within(blockText()).findByText(/^Recorded: Snapshot 2\.5TG\./);
    fireEvent.click(screen.getAllByLabelText("Remove product")[0]);
    expect(screen.getAllByLabelText("Remove product")).toHaveLength(1);
    expect(within(blockText()).getByText(/^Recorded: Snapshot 2\.5TG\./)).toBeInTheDocument();
    cleanup();
    await mountTs();
    await addHostSnapshot();
    addAddOnSnapshot();
    await within(blockText()).findByText(/^Recorded: Snapshot 2\.5TG\./);
    fireEvent.click(screen.getAllByLabelText("Remove product")[1]);
    expect(screen.getAllByLabelText("Remove product")).toHaveLength(1);
    expect(within(blockText()).queryByText(/^Recorded:/)).not.toBeInTheDocument();
    expect(within(blockText()).getByLabelText("Product used for Bed Pre-Emergent Weed Control")).toBeInTheDocument();
  });

  it("the completion asks for an add-on row's rate, unit and treated square feet before it submits; an incomplete visit skips only the ordinary row checks", () => {
    const call = pageSource.indexOf("completionProductRowProblem(service, selectedProducts, typeFor)");
    expect(call).toBeGreaterThan(0);
    expect(pageSource.slice(call - 80, call)).toContain("isIncompleteVisit ? addOnActualsProblem(service, selectedProducts) :");
    expect(pageSource.indexOf("setSubmitting(true);", call) - call).toBeLessThan(300);
    // the one helper: the method's treated-area rule first (unchanged sentence), then the add-on row's actuals
    const helper = pageSource.slice(pageSource.indexOf("function completionProductRowProblem("), pageSource.indexOf("function productApplicationMethod("));
    expect(helper).toContain("`Enter ${areaOf(missingArea).alertLabel} for ${missingArea.name}.`");
    expect(helper).toContain("addOnActualsProblem(service, rows)");
  });

  it("the completion body sends both rows: the host's untagged, the add-on's tagged (one row each, never merged)", () => {
    expect(pageSource).toContain("areaAddOnKey: p.areaAddOnKey,");
    expect(pageSource).toContain("setSelectedProducts((prev) => [...prev.filter((p) => productRowId(p) !== productRowId(row)), row]);");
    expect(pageSource).toContain("if (selectedProducts.find((p) => !p.areaAddOnKey && p.productId === product.id)) return;");
    expect(pageSource).not.toMatch(/updateProduct\(\s*sp\.productId/);
    expect(pageSource).not.toMatch(/removeProduct\(sp\.productId/);
  });
});

// Codex round 9 P1 on #6135: an add-on row must use the governed product for that add-on. The picker offers only it; the
// server flags any other product recorded for the add-on (area-addon-governed-rate.test.js).
describe("the add-on's product picker offers only the governed product", () => {
  const arena = { id: "prod-arena", name: "Arena 50 WDG", category: "insecticide", application_method: "broadcast_spray", rate_unit: "oz", default_rate_per_1000: 0.29 };
  const spot = (governed) => ({ key: "area_addon_lawn_insect_spot", name: "Lawn Insect Spot Treatment", areaSqFt: 1800, tierSqFt: 2000, areaLabel: "treated lawn", grassType: "st_augustine", governed });
  const arenaRate = { ratePer1000: 0.147, rateUnit: "oz", productId: "prod-arena", productName: "Arena 50 WDG", withheld: null };
  const optionsOf = (label) => within(screen.getByLabelText(label)).getAllByRole("option").map((option) => option.textContent);

  it("with the governed product known, it is the only choice (a rate the server holds back does not change that)", async () => {
    await act(async () => { render(<CompletionPanel service={{ ...lawnHost, ...attached([spot(arenaRate)]) }} products={[arena, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(optionsOf("Product used for Lawn Insect Spot Treatment")).toEqual(["Choose a product", "Arena 50 WDG"]);
    cleanup();
    await act(async () => { render(<CompletionPanel service={{ ...lawnHost, ...attached([spot({ ...arenaRate, withheld: "The label rate is not verified yet." })]) }} products={[arena, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(optionsOf("Product used for Lawn Insect Spot Treatment")).toEqual(["Choose a product", "Arena 50 WDG"]);
  });

  // Codex round 12 on #6135: the product is found by catalog identity on the server and sent by ID. The form never falls back to
  // the whole catalog, and never matches a name.
  it("a product renamed in the Service Library is still the governed one: the picker offers it by ID and its row takes the governed rate", async () => {
    const renamed = { ...arena, name: "Arena Pro WDG" };
    await act(async () => { render(<CompletionPanel service={{ ...lawnHost, ...attached([spot(arenaRate)]) }} products={[renamed, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(optionsOf("Product used for Lawn Insect Spot Treatment")).toEqual(["Choose a product", "Arena Pro WDG"]);
    fireEvent.change(screen.getByLabelText("Product used for Lawn Insect Spot Treatment"), { target: { value: arena.id } });
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.147);
  });

  it.each([
    ["the feed carried no governed rate", undefined, [arena, topchoice], /could not be confirmed right now/],
    ["the governed product is inactive or not in the catalog (the server says so)", { ...arenaRate, productId: null, productStatus: "inactive", productNote: "Arena 50 WDG is not an active product in the Service Library, so no product can be chosen for this add-on. Ask the office.", withheld: "x" }, [arena, topchoice], /^Arena 50 WDG is not an active product in the Service Library, so no product can be chosen for this add-on\. Ask the office\.$/],
    ["the governed product is not in the product list the form holds", arenaRate, [topchoice], /could not be confirmed right now/],
  ])("nothing is offered when %s: no picker, the plain sentence", async (_name, governed, products, sentence) => {
    await act(async () => { render(<CompletionPanel service={{ ...lawnHost, ...attached([spot(governed)]) }} products={products} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(screen.queryByLabelText("Product used for Lawn Insect Spot Treatment")).not.toBeInTheDocument();
    expect(within(blockText()).getByTestId("area-addon-no-product")).toHaveTextContent(sentence);
    expect(within(blockText()).queryByText(/Rate not filled in/)).not.toBeInTheDocument();
  });

  it("the add-on that IS the visit says so when its product cannot be chosen, and says nothing when it can", async () => {
    const own = (productNote) => ({ ...addOnAsPrimary, areaAddOnOwn: { key: "area_addon_fire_ant_yard", governed: { ratePer1000: 2, rateUnit: "lb", productName: "Topchoice Granular Insecticide", productId: productNote ? null : "x", productNote, withheld: null } } });
    await act(async () => { render(<CompletionPanel service={own("Topchoice Granular Insecticide is not an active product in the Service Library, so no product can be chosen for this add-on. Ask the office.")} products={[arena, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(screen.getByTestId("area-addon-own-note")).toHaveTextContent("so no product can be chosen for this add-on");
    cleanup();
    await act(async () => { render(<CompletionPanel service={own(null)} products={[arena, topchoice]} onClose={() => {}} onSubmit={vi.fn()} />); });
    expect(screen.queryByTestId("area-addon-own-note")).not.toBeInTheDocument();
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

// Codex round 8 P1 on #6135: the form prefilled the catalog default rate for an add-on product. The governed rate
// (protocols.json, carried on the schedule feed) replaces it: Arena 0.29 oz and Acelepryn 0.05 fl oz per 1,000 are
// not the add-on rates 0.147 and 0.184.
describe("the add-on's row starts at the GOVERNED rate, never the catalog default", () => {
  const arena = { id: "prod-arena", name: "Arena 50 WDG", category: "insecticide", application_method: "broadcast_spray", rate_unit: "oz", default_rate_per_1000: 0.29 };
  const acelepryn = { id: "prod-acel", name: "Acelepryn Insecticide", category: "insecticide", application_method: "broadcast_spray", rate_unit: "fl_oz", default_rate_per_1000: 0.05 };
  const catalogWithRates = [arena, acelepryn, topchoice];
  const spot = (governed) => ({ key: "area_addon_lawn_insect_spot", name: "Lawn Insect Spot Treatment", areaSqFt: 1800, tierSqFt: 2000, areaLabel: "treated lawn", grassType: "st_augustine", governed });
  const arenaRate = { ratePer1000: 0.147, rateUnit: "oz", productId: "prod-arena", productName: "Arena 50 WDG", withheld: null };

  async function mountWith(service, products = catalogWithRates, width = 1024) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    await act(async () => { render(<CompletionPanel service={service} products={products} onClose={() => {}} onSubmit={vi.fn()} />); });
  }

  it("a lawn host with the Arena add-on: the row prefills 0.147 oz, and the amount follows the treated area", async () => {
    await mountWith({ ...lawnHost, ...attached([spot(arenaRate)]) });
    expect(within(blockText()).getByText("Governed rate: 0.147 oz per 1,000 sq ft.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Product used for Lawn Insect Spot Treatment"), { target: { value: arena.id } });
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.147);
    fireEvent.change(screen.getByPlaceholderText("Sq ft"), { target: { value: "2000" } });
    expect(screen.getByPlaceholderText("Total")).toHaveValue(0.29);
  });

  it("the mobile form builds the same row: 0.147 oz, not the catalog 0.29", async () => {
    await mountWith({ ...lawnHost, ...attached([spot(arenaRate)]) }, catalogWithRates, 400);
    expect(within(blockText()).getByText("Governed rate: 0.147 oz per 1,000 sq ft.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Product used for Lawn Insect Spot Treatment"), { target: { value: arena.id } });
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.147);
  });

  it("the Acelepryn add-on prefills 0.184 fl oz, not the catalog 0.05", async () => {
    const preventive = { key: "area_addon_lawn_insect_preventive", name: "Yearly Lawn Insect Preventive", areaSqFt: 4000, tierSqFt: 5000, areaLabel: "lawn", grassType: null, governed: { ratePer1000: 0.184, rateUnit: "fl_oz", productId: "prod-acel", productName: "Acelepryn Insecticide", withheld: null } };
    await mountWith({ ...pestHost, ...attached([preventive]) });
    fireEvent.change(screen.getByLabelText("Product used for Yearly Lawn Insect Preventive"), { target: { value: acelepryn.id } });
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.184);
  });

  it("a rate the server holds back is not filled in (and the catalog default is not used instead), with the reason", async () => {
    const held = { ...arenaRate, withheld: "The label rate is not verified yet." };
    await mountWith({ ...lawnHost, ...attached([spot(held)]) });
    expect(within(blockText()).queryByText(/^Governed rate:/)).not.toBeInTheDocument();
    expect(within(blockText()).getByText("Rate not filled in. The label rate is not verified yet. Enter the rate from the label.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Product used for Lawn Insect Spot Treatment"), { target: { value: arena.id } });
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(null);
  });

  it("an own-visit row of a product other than the governed one starts with no rate (matched by ID, never by name)", async () => {
    const own = { ...addOnAsPrimary, serviceType: "Yearly Lawn Insect Preventive", completionProfile: { serviceKey: "area_addon_lawn_insect_preventive", category: "lawn_care", requiresProducts: false },
      areaAddOnOwn: { key: "area_addon_lawn_insect_preventive", governed: { ratePer1000: 0.184, rateUnit: "fl_oz", productName: "Acelepryn Insecticide", productId: "some-other-id", withheld: null } } };
    await mountWith(own);
    fireEvent.change(screen.getByPlaceholderText("Search products..."), { target: { value: "Acelepryn" } });
    fireEvent.click(await screen.findByText("Acelepryn Insecticide"));
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(null);
  });

  it("the add-on that IS the visit: its product from the ordinary picker prefills the governed rate too", async () => {
    const own = { ...addOnAsPrimary, serviceType: "Yearly Lawn Insect Preventive", completionProfile: { serviceKey: "area_addon_lawn_insect_preventive", category: "lawn_care", requiresProducts: false },
      areaAddOnOwn: { key: "area_addon_lawn_insect_preventive", governed: { ratePer1000: 0.184, rateUnit: "fl_oz", productId: "prod-acel", productName: "Acelepryn Insecticide", withheld: null } } };
    await mountWith(own);
    fireEvent.change(screen.getByPlaceholderText("Search products..."), { target: { value: "Acelepryn" } });
    fireEvent.click(await screen.findByText("Acelepryn Insecticide"));
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.184);
  });

  it("a row on an ordinary visit keeps the catalog prefill exactly as before", async () => {
    await mountWith(lawnHost);
    fireEvent.change(screen.getByPlaceholderText("Search products..."), { target: { value: "Arena" } });
    fireEvent.click(await screen.findByText("Arena 50 WDG"));
    expect(await screen.findByPlaceholderText("Rate")).toHaveValue(0.29);
  });

  it("the completion body carries the row's add-on tag, which the server keeps only for an add-on on the visit", () => {
    expect(pageSource).toMatch(/areaAddOnKey: p\.areaAddOnKey,\n\s+targets: Array\.isArray\(p\.targets\) \? p\.targets : \[\],\n\s+\}\)\),\n\s+\/\/ The existing completion field/);
  });
});
