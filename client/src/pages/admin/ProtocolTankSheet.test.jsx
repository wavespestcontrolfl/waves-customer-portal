// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProtocolTankSheet from "./ProtocolTankSheet";

// The server's per-fill amounts (lawn-tank-reference.js): 100 gal, the full 110 gal tank, the 4 gal FlowZone.
const tankAmounts = () => ({
  application: "spray", bigTank: true, ratePer1000: 0.227, rateUnit: "oz", planState: null,
  per100Gal: { gallons: 100, amount: 11.364, amountUnit: "oz", carrierGalPer1000: 2, carrierSource: "calibration" },
  fullTank: { gallons: 110, amount: 12.5, amountUnit: "oz", carrierGalPer1000: 2, carrierSource: "calibration" },
  backpack4Gal: { gallons: 4, amount: 0.12, amountUnit: "oz", metricAmount: 3.4, metricUnit: "g", carrierGalPer1000: 1.33, carrierSource: "calibration" },
});
function fixture() {
  return {
    month: "Sep",
    equipment: { calibrationId: "cal-1", systemName: "Test tank", tankCapacityGal: 110, carrierGalPer1000: 2, tankCoverageSqft: 55000 },
    items: [{
      selected: true,
      fullTankMix: { amount: 12.5, amountUnit: "oz" },
      tankAmounts: tankAmounts(),
      product: { id: "product-1", name: "Test product", mixingOrderCategory: "dry_wg_wdg_wp_df", labelVerifiedAt: "2026-01-01", labelUrl: "https://example.com/label.pdf", sdsUrl: "https://example.com/sds.pdf", ppeRequired: ["chemical_gloves"], compatibilityNotes: "Test compatibility restriction" },
    }],
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("110-gallon tank reference", () => {
  it("keeps products in separate tanks and preserves rainfast and re-entry directions", () => {
    const plan = fixture();
    plan.visit = { objective: 'Synthetic seasonal application deadline' };
    Object.assign(plan.items[0].product, { reiHours: 0, reentryText: 'Keep off until dry', rainfastMinutes: 180, doNotTankMixWith: ['Synthetic fertilizer restriction'], irrigationNotes: 'Synthetic irrigation restriction' });
    plan.items.push({ ...plan.items[0], product: { ...plan.items[0].product, id: 'second', name: 'Synthetic fertilizer' } });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector('.protocol-print-sheet')]) {
      expect(within(surface).getAllByText('Mixing: follow this card and the label')).toHaveLength(2);
      expect(within(surface).getByText('Products are not approved to be combined in one tank unless their card says so.')).toBeInTheDocument();
      expect(within(surface).getAllByText('180 minutes')).toHaveLength(2);
      expect(within(surface).getAllByText('Keep off until dry')).toHaveLength(2);
      expect(within(surface).getAllByText('Synthetic fertilizer restriction')).toHaveLength(2);
      expect(within(surface).getAllByText('Synthetic irrigation restriction')).toHaveLength(2);
      expect(within(surface).getByText('Synthetic seasonal application deadline')).toBeInTheDocument();
      expect(within(surface).queryByText(/0 hours/)).not.toBeInTheDocument();
    }
  });
  it("retains the EPA label fallback on screen and in print when only registration is stored", () => {
    const plan = fixture();
    Object.assign(plan.items[0].product, { labelUrl: null, epaRegNumber: "123-456-789" });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Product label")).toHaveAttribute("href", "https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102::::::P102_REG_NUM:123-456-789");
      expect(within(surface).queryByText("Product label document not on file")).not.toBeInTheDocument();
    }
  });

  it("preserves product-specific triggers and application scope on screen and in print", () => {
    const plan = fixture();
    Object.assign(plan.items[0], { conditional: true, raw: "Spot treat only if the synthetic threshold is met", scope: "spot" });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Spot treat only if the synthetic threshold is met")).toBeInTheDocument();
      expect(within(surface).getByText("Application scope")).toBeInTheDocument();
      expect(within(surface).getByText("spot")).toBeInTheDocument();
      expect(within(surface).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    }
  });

  it("uses the server tank amount and includes safety documents in the printable sheet", () => {
    const { container } = render(<ProtocolTankSheet plan={fixture()} safetyRules={["Test seasonal restriction"]} />);
    const screenDocument = container.querySelector(".waves-field-document-body");
    const printDocument = document.querySelector(".protocol-print-sheet .waves-field-document");
    for (const surface of [screenDocument, printDocument]) {
      expect(within(surface).getByRole("heading", { level: 1, name: "110-gallon tank mixing reference" })).toBeInTheDocument();
      expect(within(surface).getByText("Controlled staff document")).toBeInTheDocument();
      expect(surface.querySelector("img")).toBeNull();
      expect(surface.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
    }
    expect(within(container).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    const printed = within(document.querySelector(".protocol-print-sheet"));
    expect(printed.getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    expect(printed.getByText("chemical gloves")).toBeInTheDocument();
    expect(printed.getByText("Test compatibility restriction")).toBeInTheDocument();
    expect(printed.getByText("Test seasonal restriction")).toBeInTheDocument();
    expect(printed.getByText("Product label")).toHaveAttribute("href", "https://example.com/label.pdf");
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const printButton = screen.getByRole("button", { name: "Print mixing reference" });
    expect(screenDocument).not.toContainElement(printButton);
    expect(printButton.closest(".waves-field-no-print")).not.toBeNull();
    fireEvent.click(printButton);
    expect(print).toHaveBeenCalledOnce();
  });

  it("lists every fill: 100 gal, the full tank, the FlowZone with a small amount also in grams, and a line's own spray volume", () => {
    const plan = fixture();
    Object.assign(plan.items[0].tankAmounts, { fixedCarrierGalPer1000: 4, fixedCarrierSource: "line" });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("0.227 oz per 1,000 sq ft")).toBeInTheDocument();
      expect(within(surface).getByText("100 gal tank").nextSibling).toHaveTextContent("11.364 oz");
      expect(within(surface).getByText("Full 110 gal tank").nextSibling).toHaveTextContent("12.5 oz");
      expect(within(surface).getByText("FlowZone 4 gal").nextSibling).toHaveTextContent("0.12 oz (3.4 g)");
      expect(within(surface).getByText("4 gal per 1,000 sq ft (protocol line)")).toBeInTheDocument();
    }
  });

  it("a spot product heads with its FlowZone amount; a spreader product shows its rate and no tank amount", () => {
    const plan = fixture();
    Object.assign(plan.items[0].tankAmounts, { bigTank: false, per100Gal: null, fullTank: null });
    plan.items.push({ selected: true, product: { id: "bag", name: "Synthetic granular", labelVerifiedAt: "2026-01-01" },
      tankAmounts: { application: "spreader", ratePer1000: 3.125, rateUnit: "lb", per100Gal: null, fullTank: null, backpack4Gal: null } });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toBeInTheDocument();
    expect(within(container).getByText("3.125 lb / 1,000 sq ft")).toBeInTheDocument();
    expect(within(container).getByText("3.125 lb per 1,000 sq ft")).toBeInTheDocument();
    expect(within(container).queryByText("Tank mixing not set in the app. Check the label.")).not.toBeInTheDocument();
  });

  it("a spreader card shows the server's LESCO spreader number, on screen and in print, beside its rate", () => {
    const plan = fixture();
    const bag = (id, spreader) => ({ selected: true, product: { id, name: `Synthetic granular ${id}`, labelVerifiedAt: "2026-01-01" }, spreader,
      tankAmounts: { application: "spreader", applicator: "spreader", ratePer1000: 3.125, rateUnit: "lb", per100Gal: null, fullTank: null, backpack4Gal: null } });
    plan.items = [
      bag("a", { setting: 9.5, basis: "start", text: "Spreader: LESCO #9½, start number. Weigh test at first use." }),
      bag("b", { setting: null, text: "No spreader number for this rate: weigh test." }),
      bag("c", null),
    ];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Spreader: LESCO #9½, start number. Weigh test at first use.")).toBeInTheDocument();
      expect(within(surface).getByText("No spreader number for this rate: weigh test.")).toBeInTheDocument();
      expect(within(surface).getAllByText("3.125 lb / 1,000 sq ft")).toHaveLength(3);
    }
  });

  it("an overdue or estimated sprayer test shows the server's one warning line and keeps every amount", () => {
    const plan = fixture();
    plan.equipment.expiresAt = new Date(Date.now() - 60000).toISOString();
    plan.warnings = [{ code: "calibration_overdue_or_estimated", message: "Sprayer test overdue: Test tank last tested 2026-09-07 at 2 gal per 1,000 sq ft. Amounts below assume that. Test the sprayer again." }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText(/Sprayer test overdue: Test tank last tested 2026-09-07/)).toBeInTheDocument();
    expect(within(container).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    expect(within(container).queryByText(/Tank quantities are unavailable/)).not.toBeInTheDocument();
  });

  it("a granular product is a spreader card, on screen and in print: no single-product tank, and the tank sentence names sprayed products", () => {
    const plan = fixture();
    plan.items = [{ selected: true, product: { id: "bag", name: "Synthetic granular", labelVerifiedAt: "2026-01-01" },
      tankAmounts: { application: "spreader", ratePer1000: 3.125, rateUnit: "lb", per100Gal: null, fullTank: null, backpack4Gal: null } }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Spreader")).toBeInTheDocument();
      expect(within(surface).queryByText("Separate single-product tank")).not.toBeInTheDocument();
      expect(within(surface).queryByText(/Apply alone|Mixing: follow/)).not.toBeInTheDocument();
    }
  });

  it("an additive whose base product is not on the sheet gets neutral wording, never its own tank or an add instruction", () => {
    const plan = fixture();
    plan.items = [{ selected: true, conditional: true, product: { id: "nis", name: "Synthetic surfactant", labelVerifiedAt: "2026-01-01", mixingOrderCategory: "adjuvant_last" },
      tankAmounts: { application: "spray", concentrationPercent: 0.25, mixWith: "Celsius WG", mixWithProductIds: ["cel"], per100Gal: null, fullTank: null,
        backpack4Gal: { gallons: 4, amount: 1.28, amountUnit: "fl oz", carrierSource: "concentration" } } }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Mixing: follow this card and the label")).toBeInTheDocument();
      expect(within(surface).queryByText(/Add to the/)).not.toBeInTheDocument();
      expect(within(surface).queryByText("Separate single-product tank")).not.toBeInTheDocument();
      expect(within(surface).getByText("0.25% of the spray volume")).toBeInTheDocument();
    }
  });

  it("named cultivar exclusions do not read as a species-wide prohibition", () => {
    const plan = fixture();
    plan.items[0].product.excludedTurfSpecies = ["floratam", "st_augustine_unknown_cultivar"];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).queryByText("Not labeled for St. Augustine.")).not.toBeInTheDocument();
    expect(within(container).getByText("Excluded turf: floratam, st_augustine_unknown_cultivar")).toBeInTheDocument();
  });

  it("the mix base names what the program adds to it; an apply-alone product says so; an unselected product prints its required notes", () => {
    const plan = fixture();
    const spray = (id, name, extra) => ({ selected: false, conditional: true, product: { id, name, labelVerifiedAt: "2026-01-01", mixingOrderCategory: "dry_wg_wdg_wp_df" },
      tankAmounts: { ...tankAmounts(), bigTank: false, per100Gal: null, fullTank: null, ...extra } });
    plan.items = [
      { ...spray("cel", "Celsius WG", {}), selected: true },
      { ...spray("cer", "Certainty Turf Herbicide", { mixWith: "Celsius WG", mixWithProductIds: ["cel"] }), selected: true },
      // Partners that are not today's instruction: unselected, or selected but at a limit.
      spray("nis", "Synthetic surfactant", { mixWith: "Celsius WG", mixWithProductIds: ["cel"] }),
      { ...spray("cap", "Synthetic capped partner", { mixWith: "Celsius WG", mixWithProductIds: ["cel"], planState: "capped" }), selected: true },
      spray("tet", "Tetrino Insecticide", { applyAlone: true }),
      { ...spray("step", "Synthetic removal step", {}), gateNotes: [{ key: "x", severity: "required", text: "Keep the synthetic 2(ee) sheet on hand." }, { key: "y", severity: "note", text: "Synthetic note only." }] },
    ];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Tank with: Certainty Turf Herbicide")).toBeInTheDocument();
      // Only the selected, uncapped partner is told to add itself; the others get neutral wording.
      expect(within(surface).getAllByText("Add to the Celsius WG mix")).toHaveLength(1);
      expect(within(surface).getByText("Apply alone in its own tank")).toBeInTheDocument();
      expect(within(surface).getByText("Keep the synthetic 2(ee) sheet on hand.")).toHaveClass("text-alert-fg");
      expect(within(surface).queryByText("Synthetic note only.")).not.toBeInTheDocument();
    }
  });

  it("an unselected product keeps its amounts and says its limits are not checked; a selected one does not", () => {
    const plan = fixture();
    plan.items.push({ ...plan.items[0], selected: false, conditional: true, product: { ...plan.items[0].product, id: "opt", name: "Synthetic optional" } });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Not selected: yearly and visit limits are not checked here.")).toHaveLength(1);
      expect(within(surface).getAllByText("12.5 oz / 110 gal")).toHaveLength(2);
    }
  });

  it("a backpack amount names the FlowZone unit whose number it used, never calling an owner estimate a test", () => {
    const plan = fixture();
    plan.items[0].tankAmounts.backpack4Gal.sprayerName = "FlowZone Typhoon Backpack #2";
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("FlowZone 4 gal").nextSibling).toHaveTextContent(/^0\.12 oz \(3\.4 g\) · FlowZone Typhoon Backpack #2$/);
    }
  });

  it("no mix instruction when the base product is unselected or capped", () => {
    const plan = fixture();
    const item = (id, name, extra, selected) => ({ selected, conditional: true, product: { id, name, labelVerifiedAt: "2026-01-01", mixingOrderCategory: "dry_wg_wdg_wp_df" },
      tankAmounts: { ...tankAmounts(), bigTank: false, per100Gal: null, fullTank: null, ...extra } });
    for (const base of [item("cel", "Celsius WG", {}, false), item("cel", "Celsius WG", { planState: "capped" }, true)]) {
      plan.items = [base, item("cer", "Certainty Turf Herbicide", { mixWith: "Celsius WG", mixWithProductIds: ["cel"] }, true)];
      const { container, unmount } = render(<ProtocolTankSheet plan={plan} />);
      expect(within(container).queryByText(/Add to the|Tank with/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("says once, on screen and in print, that limits are checked on the job card", () => {
    const { container } = render(<ProtocolTankSheet plan={fixture()} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Reference amounts. Yearly and visit limits are checked on the job card, not here.")).toHaveLength(1);
    }
  });

  it("a volume stated for one use of the line shows that use's own fill beside the sprayer's", () => {
    const plan = fixture();
    plan.items[0].tankAmounts.useFills = [{ use: "mapped large patch", carrierGalPer1000: 2, per100Gal: null,
      backpack4Gal: { gallons: 4, amount: 0.454, amountUnit: "oz", carrierGalPer1000: 2, carrierSource: "line" } }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("FlowZone 4 gal, mapped large patch").nextSibling).toHaveTextContent("0.454 oz at 2 gal per 1,000 sq ft");
    expect(within(container).getByText("FlowZone 4 gal").nextSibling).toHaveTextContent("0.12 oz (3.4 g)");
  });

  it("a card whose only amounts are per-use fills heads with the first of them, never No amount", () => {
    const plan = fixture();
    Object.assign(plan.items[0].tankAmounts, { per100Gal: null, fullTank: null, backpack4Gal: null, backpackMissing: true, useFills: [{ use: "mapped large patch", carrierGalPer1000: 2, per100Gal: null,
      backpack4Gal: { gallons: 4, amount: 0.454, amountUnit: "oz", carrierGalPer1000: 2, carrierSource: "line" } }] });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("0.454 oz / 4 gal FlowZone, mapped large patch").length).toBeGreaterThan(0);
      expect(within(surface).queryByText("No amount")).not.toBeInTheDocument();
    }
  });

  it("a program volume the sprayer number does not put out says how to put one 1,000 sq ft dose on, never a pass count", () => {
    const plan = fixture();
    plan.items[0].tankAmounts.volumeChecks = [
      { use: null, sprayerName: "Fixture tank", labelGalPer1000: 4, sprayerGalPer1000: 2 },
      // A second sprayer at another number below the label volume reads the same: one line, no names.
      { use: null, sprayerName: "FlowZone fixture", labelGalPer1000: 4, sprayerGalPer1000: 1.33 },
      { use: "mapped large patch", sprayerName: "Fixture tank", labelGalPer1000: 4, sprayerGalPer1000: 2 },
    ];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Label volume 4 gal per 1,000 sq ft: mix one 1,000 sq ft dose in 4 gal, and put it on 1,000 sq ft in two crossing passes.")).toHaveLength(1);
      expect(within(surface).getByText("Mapped large patch: Label volume 4 gal per 1,000 sq ft: mix one 1,000 sq ft dose in 4 gal, and put it on 1,000 sq ft in two crossing passes.")).toBeInTheDocument();
      expect(within(surface).queryByText(/passes, or|Speed up|Slow down|tested at/)).not.toBeInTheDocument();
      expect(within(surface).getAllByText("12.5 oz / 110 gal").length).toBeGreaterThan(0);
    }
  });

  it("a sprayer on each side of the label volume: each line names its sprayer", () => {
    const plan = fixture();
    plan.items[0].tankAmounts.volumeChecks = [
      { use: null, sprayerName: "Fixture tank", labelGalPer1000: 1, sprayerGalPer1000: 2 },
      { use: null, sprayerName: "FlowZone fixture", labelGalPer1000: 1, sprayerGalPer1000: 0.5 },
    ];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("Label volume 1 gal per 1,000 sq ft: this sprayer puts down more. Mix one 1,000 sq ft dose in 1 gal and cover 1,000 sq ft. (Fixture tank)")).toBeInTheDocument();
    expect(within(container).getByText("Label volume 1 gal per 1,000 sq ft: mix one 1,000 sq ft dose in 1 gal, and put it on 1,000 sq ft in two crossing passes. (FlowZone fixture)")).toBeInTheDocument();
  });

  it("a spot product's FlowZone fill at the label rate per gallon says so", () => {
    const plan = fixture();
    plan.items[0].tankAmounts.backpack4Gal = { gallons: 4, amount: 0.8, amountMax: 3.2, amountUnit: "fl_oz", carrierSource: "label_per_gallon", carrierGalPer1000: null, sprayerName: null };
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("FlowZone 4 gal").nextSibling).toHaveTextContent(/^0\.8 to 3\.2 .* · label spot rate per gallon$/);
  });

  it("a sprayer number's note (owner estimate, no expiry) is plain text, not an alert", () => {
    const plan = fixture();
    plan.warnings = [{ code: "sprayer_number", severity: "note", message: "FlowZone Typhoon 3.0 #1: 2 gal per 1,000 sq ft, owner estimate." }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("FlowZone Typhoon 3.0 #1: 2 gal per 1,000 sq ft, owner estimate.")).not.toHaveClass("text-alert-fg");
  });

  it("the Celsius heat rule shows on the surfactant card always, and on the Celsius card when they mix", () => {
    const plan = fixture();
    const rule = "Leave the surfactant out if it is 90°F or hotter.";
    const item = (id, name, extra, selected) => ({ selected, conditional: true, product: { id, name, labelVerifiedAt: "2026-01-01", mixingOrderCategory: "adjuvant_last" },
      tankAmounts: { ...tankAmounts(), bigTank: false, per100Gal: null, fullTank: null, ...extra } });
    plan.items = [item("cel", "Celsius WG", {}, true), item("nis", "Synthetic surfactant", { mixWith: "Celsius WG", mixWithProductIds: ["cel"], surfactantNote: rule }, true)];
    const { container, unmount } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getAllByText(rule)).toHaveLength(2);
    expect(within(document.querySelector(".protocol-print-sheet")).getAllByText(rule)).toHaveLength(2);
    unmount();
    // Neither selected: the surfactant card still carries it; the Celsius card does not.
    plan.items[0].selected = false;
    plan.items[1].selected = false;
    const again = render(<ProtocolTankSheet plan={plan} />);
    expect(within(again.container).getAllByText(rule)).toHaveLength(1);
    expect(within(document.querySelector(".protocol-print-sheet")).getAllByText(rule)).toHaveLength(1);
  });

  // The Bermuda removal step (lawn-bermuda-removal.js): the server's step order, by product id; no order for a blocked step.
  const bermudaPlan = (overrides = {}) => {
    const plan = fixture();
    const item = (id, name, category, mixWith) => ({ selected: true, conditional: true, bermudaStep: true, product: { id, name, labelVerifiedAt: "2026-01-01", mixingOrderCategory: category },
      tankAmounts: { ...tankAmounts(), bigTank: false, per100Gal: null, fullTank: null, mixWith }, ...overrides[id] });
    // The catalog's short name for Recognition does not start with the staged name the marks use: the ids still tie them.
    plan.items = [
      item("nis", "Synthetic surfactant", "adjuvant_last", "Recognition Post Emergent Herbicide and Fusilade II"),
      item("fus", "Fusilade II", "ec_ew", "Recognition Post Emergent Herbicide"),
      item("rec", "Recognition", "dry_wg_wdg_wp_df", "Fusilade II"),
    ];
    plan.bermudaMixingOrder = [{ step: 1, productId: null, productName: "Water" },
      { step: 2, productId: "rec", productName: "Recognition" }, { step: 3, productId: "fus", productName: "Fusilade II" }, { step: 4, productId: "nis", productName: "Synthetic surfactant" }];
    return plan;
  };

  it("Bermuda removal: every card names the one shared tank by product id, the surfactant last, never the herbicides pointing at each other", () => {
    const { container } = render(<ProtocolTankSheet plan={bermudaPlan()} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Same tank: Recognition + Fusilade II + Synthetic surfactant")).toHaveLength(3);
      expect(within(surface).queryByText(/Add to the|Tank with/)).not.toBeInTheDocument();
    }
  });

  // The mix safety table's answer (server /lawn-mix mixCheck): one pair per two products, shown under each shared tank line.
  const weedMixPlan = (pairs) => {
    const plan = fixture();
    const item = (id, name, extra) => ({ selected: true, conditional: true, product: { id, name, labelVerifiedAt: "2026-01-01", mixingOrderCategory: "dry_wg_wdg_wp_df" },
      tankAmounts: { ...tankAmounts(), bigTank: false, per100Gal: null, fullTank: null, ...extra } });
    plan.items = [item("cel", "Celsius WG", {}), item("nis", "Synthetic surfactant", { mixWith: "Celsius WG", mixWithProductIds: ["cel"] })];
    plan.mixCheck = pairs === undefined ? undefined : { pairs };
    return plan;
  };
  const pair = (verdict, reason) => ({ productAId: "cel", productAName: "Celsius WG", productBId: "nis", productBName: "Synthetic surfactant", verdict, reason });

  it.each([
    ["caution", "Approved weed mix.", "Caution: Approved weed mix."],
    // Unknown keeps the service's own words: read both labels, jar test first.
    ["unknown", "No rule on file. Read both labels; jar test first.", "No rule on file. Read both labels; jar test first."],
  ])("a %s pair shows its line under both cards' tank lines, on screen and in print, and the amounts stay", (verdict, reason, text) => {
    const { container } = render(<ProtocolTankSheet plan={weedMixPlan([pair(verdict, reason)])} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Tank with: Synthetic surfactant")).toBeInTheDocument();
      expect(within(surface).getByText("Add to the Celsius WG mix")).toBeInTheDocument();
      expect(within(surface).getAllByText(text)).toHaveLength(2);
      // A warning only: both products keep their names and amounts.
      expect(within(surface).getAllByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toHaveLength(2);
    }
  });

  it("a Never pair replaces both cards' mix line with Do not mix, on screen and in print; products and amounts stay", () => {
    const plan = weedMixPlan([pair("never", "Label: no surfactant.")]);
    plan.items[1].raw = "Synthetic surfactant in the Celsius weed mix";
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      // The protocol's own line stays as written, with the pair's line under it (it names its partner, Celsius).
      expect(within(surface).getByText("Synthetic surfactant in the Celsius weed mix")).toBeInTheDocument();
      expect(within(surface).getAllByText("Do not mix: Celsius WG + Synthetic surfactant. Label: no surfactant. Ask the office before you mix this tank.")).toHaveLength(3);
      expect(within(surface).queryByText("Tank with: Synthetic surfactant")).not.toBeInTheDocument();
      expect(within(surface).queryByText("Add to the Celsius WG mix")).not.toBeInTheDocument();
      expect(within(surface).getByRole("heading", { name: "Celsius WG" })).toBeInTheDocument();
      expect(within(surface).getByRole("heading", { name: "Synthetic surfactant" })).toBeInTheDocument();
      expect(within(surface).getAllByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toHaveLength(2);
    }
  });

  it("in a tank of three, a Never pair replaces the mix line on all three cards, on screen and in print; amounts stay", () => {
    const plan = bermudaPlan();
    plan.mixCheck = { pairs: [
      { productAId: "rec", productAName: "Recognition", productBId: "nis", productBName: "Synthetic surfactant", verdict: "never", reason: "Label bars it." },
      { productAId: "rec", productAName: "Recognition", productBId: "fus", productBName: "Fusilade II", verdict: "caution", reason: "Jar test first." },
    ] };
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Do not mix: Recognition + Synthetic surfactant. Label bars it. Ask the office before you mix this tank.")).toHaveLength(3);
      // Fusilade II is not in the Never pair, and its card still never tells staff to combine the three.
      expect(within(surface).queryByText(/^Same tank:/)).not.toBeInTheDocument();
      // The Caution stays under the replaced line; every product keeps its card and amount.
      expect(within(surface).getAllByText("Caution: Jar test first. (Recognition + Fusilade II)")).toHaveLength(3);
      for (const name of ["Recognition", "Fusilade II", "Synthetic surfactant"]) expect(within(surface).getByRole("heading", { name })).toBeInTheDocument();
      expect(within(surface).getAllByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toHaveLength(3);
    }
  });

  it("a Never pair inside the card's tank warns under its mix line and its own directions, which stay as written", () => {
    const plan = weedMixPlan([pair("never", "Label: no surfactant.")]);
    plan.items[0].product.mixingInstructions = "Mix Celsius WG first, then add Synthetic surfactant.";
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Do not mix: Celsius WG + Synthetic surfactant. Label: no surfactant. Ask the office before you mix this tank.")).toHaveLength(3);
      expect(within(surface).getByText("Mix Celsius WG first, then add Synthetic surfactant.")).toBeInTheDocument();
      expect(within(surface).getAllByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toHaveLength(2);
    }
  });

  it("ties by product id only: a LESCO product outside the tank gets no line, and an unresolved partner name says No rule on file", () => {
    const plan = weedMixPlan([{ productAId: "cel", productAName: "Celsius WG", productBId: "nis", productBName: "LESCO 90/10 Nonionic Surfactant", verdict: "never", reason: "Fixture rule." }]);
    plan.items[1].product.name = "LESCO 90/10 Nonionic Surfactant";
    plan.items[0].raw = "Celsius WG + NIS broadleaf";
    const other = (id, name, raw, extra) => ({ ...plan.items[1], raw, product: { ...plan.items[1].product, id, name }, tankAmounts: { ...plan.items[1].tankAmounts, ...extra } });
    plan.items.push(
      // Its text names the LESCO surfactant, but it shares no tank with Celsius: no line.
      other("kflow", "LESCO K-Flow 0-0-25", "LESCO K-Flow 0-0-25 with LESCO 90/10 Nonionic Surfactant", { mixWith: null, mixWithProductIds: undefined }),
      // The program names a partner the resolver could not tie to any product.
      other("mys", "Synthetic additive", "Synthetic additive", { mixWith: "Unknown blend", mixWithProductIds: [] }),
    );
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      const line = "Do not mix: Celsius WG + LESCO 90/10 Nonionic Surfactant. Fixture rule. Ask the office before you mix this tank.";
      // The two mix lines and the Celsius protocol line ("NIS"), all by id.
      expect(within(surface).getAllByText(line)).toHaveLength(3);
      const kflow = within(surface).getByRole("heading", { name: "LESCO K-Flow 0-0-25" }).closest("section");
      expect(within(kflow).queryByText(/^Do not mix: /)).not.toBeInTheDocument();
      const unknown = within(surface).getByRole("heading", { name: "Synthetic additive" }).closest("section");
      expect(within(unknown).getByText("No rule on file")).toBeInTheDocument();
      expect(within(unknown).getByText("Mixing: follow this card and the label")).toBeInTheDocument();
    }
  });

  it("one surfactant in both tanks: each row keeps its own tank; a Never pair in the backpack leaves the weed mix row alone", () => {
    const plan = weedMixPlan([{ productAId: "rec", productAName: "Recognition", productBId: "nis", productBName: "Synthetic surfactant", verdict: "never", reason: "Fixture rule." }]);
    const backpack = (id, name) => ({ ...plan.items[0], bermudaStep: true, product: { ...plan.items[0].product, id, name }, tankAmounts: { ...plan.items[0].tankAmounts } });
    plan.items.push(backpack("rec", "Recognition"), backpack("nis", "Synthetic surfactant"));
    plan.bermudaMixingOrder = [{ step: 1, productId: "rec", productName: "Recognition" }, { step: 2, productId: "nis", productName: "Synthetic surfactant" }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      // The two backpack cards only.
      expect(within(surface).getAllByText("Do not mix: Recognition + Synthetic surfactant. Fixture rule. Ask the office before you mix this tank.")).toHaveLength(2);
      expect(within(surface).getByText("Add to the Celsius WG mix")).toBeInTheDocument();
      expect(within(surface).getByText("Tank with: Synthetic surfactant")).toBeInTheDocument();
    }
  });

  it("base tank and backpack tank are checked apart: a base product and a backpack product never pair, even through a shared product", () => {
    const plan = weedMixPlan([{ productAId: "cel", productAName: "Celsius WG", productBId: "rec", productBName: "Recognition", verdict: "never", reason: "Fixture rule." }]);
    delete plan.items[1].tankAmounts.mixWith;
    delete plan.items[1].tankAmounts.mixWithProductIds;
    plan.items.push({ ...plan.items[1], bermudaStep: true, product: { ...plan.items[1].product, id: "rec", name: "Recognition" } });
    // The surfactant is in both tanks; Celsius only in the base tank, Recognition only in the backpack.
    plan.mixingOrder = [{ step: 1, productId: "cel", productName: "Celsius WG" }, { step: 2, productId: "nis", productName: "Synthetic surfactant" }];
    plan.bermudaMixingOrder = [{ step: 1, productId: "nis", productName: "Synthetic surfactant" }, { step: 2, productId: "rec", productName: "Recognition" }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).queryByText(/^Do not mix: /)).not.toBeInTheDocument();
      expect(within(surface).getByText("Same tank: Synthetic surfactant + Recognition")).toBeInTheDocument();
    }
  });

  it("a failed mix check shows one Mix check unavailable line, on screen and in print; products and amounts stay", () => {
    const plan = weedMixPlan([]);
    plan.mixCheck = { status: "unavailable", pairs: [] };
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Mix check unavailable. Check the labels.")).toHaveLength(1);
      expect(within(surface).getByText("Tank with: Synthetic surfactant")).toBeInTheDocument();
      expect(within(surface).getAllByText("0.12 oz (3.4 g) / 4 gal FlowZone")).toHaveLength(2);
    }
  });

  it("a Yes pair, no check (a failed check) or a product with no shared tank shows no mix safety line", () => {
    for (const plan of [weedMixPlan([pair("ok", "Owner checked.")]), weedMixPlan(undefined), weedMixPlan(null)]) {
      const { container, unmount } = render(<ProtocolTankSheet plan={plan} />);
      expect(within(container).queryByText(/^Caution: |^Do not mix: |^No rule on file/)).not.toBeInTheDocument();
      expect(within(container).getByText("Tank with: Synthetic surfactant")).toBeInTheDocument();
      unmount();
    }
    // Not in the same tank (the partner is unselected): no line, even with a Never pair on the sheet.
    const apart = weedMixPlan([pair("never", "Label: no surfactant.")]);
    apart.items[1].selected = false;
    const { container } = render(<ProtocolTankSheet plan={apart} />);
    expect(within(container).queryByText(/^Do not mix: /)).not.toBeInTheDocument();
  });

  it("a pair that asks for a jar test says so on screen and in print, a Yes pair included", () => {
    for (const verdict of ["ok", "caution"]) {
      const { container, unmount } = render(<ProtocolTankSheet plan={weedMixPlan([{ ...pair(verdict, "Owner checked."), jarTestRequired: true }])} />);
      for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
        expect(within(surface).getAllByText("Jar test first")).toHaveLength(2);
      }
      expect(within(container).queryAllByText("Caution: Owner checked.")).toHaveLength(verdict === "caution" ? 2 : 0);
      unmount();
    }
  });

  it("a shared tank of three names each pair; only pairs inside the tank show", () => {
    const plan = bermudaPlan();
    plan.mixCheck = { pairs: [
      { productAId: "REC", productAName: "Recognition", productBId: "fus", productBName: "Fusilade II", verdict: "caution", reason: "Jar test first." },
      { productAId: "fus", productAName: "Fusilade II", productBId: "nis", productBName: "Synthetic surfactant", verdict: "ok", reason: "Fine." },
      { productAId: "rec", productAName: "Recognition", productBId: "other", productBName: "Not in this tank", verdict: "never", reason: "Elsewhere." },
    ] };
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getAllByText("Caution: Jar test first. (Recognition + Fusilade II)")).toHaveLength(3);
    expect(within(container).queryByText(/Elsewhere/)).not.toBeInTheDocument();
  });

  it("a blocked Bermuda removal step gives no mix line on any card, and the amounts stay", () => {
    const unavailable = { unavailable: { reason: "Synthetic limit reached." } };
    const blocked = { ...bermudaPlan({ rec: { ...unavailable, tankAmounts: { ...tankAmounts(), planState: "capped" } }, fus: unavailable, nis: unavailable }), bermudaMixingOrder: undefined };
    // A step the server marks unavailable, a capped member, or an unselected member: never a partial "Same tank".
    for (const plan of [blocked, bermudaPlan({ rec: { selected: false } }), bermudaPlan({ fus: { tankAmounts: { ...tankAmounts(), planState: "capped" } } })]) {
      const { container, unmount } = render(<ProtocolTankSheet plan={plan} />);
      for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
        expect(within(surface).queryByText(/Same tank|Add to the|Tank with/)).not.toBeInTheDocument();
        expect(within(surface).getAllByText("Mixing: follow this card and the label")).toHaveLength(3);
      }
      expect(within(container).getAllByText("FlowZone 4 gal").length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("a SKIP line shows no amount and no fill: its heading says Skipped this round", () => {
    const plan = fixture();
    plan.items[0].tankAmounts = { ...tankAmounts(), skipped: true, per100Gal: null, fullTank: null, backpack4Gal: null };
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getAllByText("Skipped this round").length).toBeGreaterThan(0);
      expect(within(surface).queryByText(/100 gal tank|FlowZone 4 gal|No amount/)).not.toBeInTheDocument();
    }
  });

  it("a hand-shaker bait says Hand shaker, on screen and in print", () => {
    const plan = fixture();
    plan.items = [{ selected: false, conditional: true, product: { id: "adv", name: "Synthetic bait granule", labelVerifiedAt: "2026-01-01" },
      tankAmounts: { application: "spreader", applicator: "hand_shaker", ratePer1000: 3, rateUnit: "lb", per100Gal: null, fullTank: null, backpack4Gal: null } }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Hand shaker")).toBeInTheDocument();
      expect(within(surface).queryByText("Spreader")).not.toBeInTheDocument();
    }
  });

  it("a carrier taken from the program row is labeled so", () => {
    const plan = fixture();
    Object.assign(plan.items[0].tankAmounts, { fixedCarrierGalPer1000: 2, fixedCarrierSource: "row" });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("2 gal per 1,000 sq ft (from the program row)")).toBeInTheDocument();
  });

  it("a FlowZone with no sprayer test says so in place of its amount", () => {
    const plan = fixture();
    Object.assign(plan.items[0].tankAmounts, { backpack4Gal: null, backpackMissing: true });
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("FlowZone 4 gal").nextSibling).toHaveTextContent("No FlowZone test on file. Test it to show this.");
  });

  // Owner 2026-11-26: every safety or limit alert is a warning only. Each check that once withheld the amount is now a short
  // warning beside it.
  it.each([
    ["different tank", (p) => { p.equipment.tankCapacityGal = 4; }, null],
    ["expired calibration", (p) => { p.equipment.expiresAt = new Date(Date.now() - 60000).toISOString(); }, null],
    ["unverified label", (p) => { p.items[0].product.labelVerifiedAt = null; }, "Label not verified in the app."],
    ["non-tank product", (p) => { p.items[0].product.mixingOrderCategory = "granular"; }, "Tank mixing not set in the app. Check the label."],
    ["excluded St. Augustine", (p) => { p.items[0].product.excludedTurfSpecies = ["St. Augustine"]; }, "Not labeled for St. Augustine."],
    ["unknown St. Augustine cultivar", (p) => { p.items[0].product.excludedTurfSpecies = ["floratam", "bitterblue", "st_augustine_unknown_cultivar"]; }, "Excluded turf: floratam, bitterblue, st_augustine_unknown_cultivar"],
    ["unselected conditional", (p) => { p.items[0].selected = false; p.items[0].conditional = true; p.items[0].fullTankMix = null; }, "Conditional: confirm the trigger first."],
    ["reached application limit", (p) => { p.items[0].tankAmounts.planState = "capped"; p.items[0].fullTankMix = null; }, "Limit reached: do not apply at this visit."],
    ["city hold", (p) => { p.items[0].tankAmounts.planState = "held"; }, "City hold: do not apply at this visit."],
    ["field hold", (p) => { p.items[0].fieldHold = "tetrino_scout_evidence_required"; }, "On hold: see the warning above."],
  ])("keeps the amount and warns for %s", (_name, change, caution) => {
    const plan = fixture();
    change(plan);
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
      expect(within(surface).queryByText("Quantity withheld")).not.toBeInTheDocument();
      if (caution) expect(within(surface).getByText(caution)).toHaveClass("text-alert-fg");
    }
  });

  it("keeps the no-combining sentence and leaves an amount out only when the server sends none", () => {
    const plan = fixture();
    plan.items[0].tankAmounts = { application: "spray", ratePer1000: 0.227, rateUnit: "oz", per100Gal: null, fullTank: null, backpack4Gal: null };
    plan.warnings = [{ code: "missing_calibration", message: "No sprayer test on file for the selected tank: amounts that need its spray volume are not shown." }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText("Products are not approved to be combined in one tank unless their card says so.")).toBeInTheDocument();
    expect(within(container).getByText("No amount")).toBeInTheDocument();
    expect(within(container).getByText("No sprayer test on file for the selected tank: amounts that need its spray volume are not shown.")).toBeInTheDocument();
  });
});
