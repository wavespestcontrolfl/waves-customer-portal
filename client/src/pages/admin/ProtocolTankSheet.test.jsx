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
      expect(within(surface).getAllByText('Separate single-product tank')).toHaveLength(2);
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
      expect(within(surface).queryByText(/needs its own tank/)).not.toBeInTheDocument();
    }
  });

  it("a product the program adds to another mix is an additive card, on screen and in print, never its own tank", () => {
    const plan = fixture();
    plan.items = [{ selected: true, conditional: true, product: { id: "nis", name: "Synthetic surfactant", labelVerifiedAt: "2026-01-01", mixingOrderCategory: "adjuvant_last" },
      tankAmounts: { application: "spray", concentrationPercent: 0.25, mixWith: "Celsius WG", per100Gal: null, fullTank: null,
        backpack4Gal: { gallons: 4, amount: 1.28, amountUnit: "fl oz", carrierSource: "concentration" } } }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Add to the Celsius WG mix")).toBeInTheDocument();
      expect(within(surface).queryByText("Separate single-product tank")).not.toBeInTheDocument();
      expect(within(surface).queryByText(/needs its own tank/)).not.toBeInTheDocument();
      expect(within(surface).getByText("0.25% of the spray volume")).toBeInTheDocument();
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
    ["unknown St. Augustine cultivar", (p) => { p.items[0].product.excludedTurfSpecies = ["floratam", "bitterblue", "st_augustine_unknown_cultivar"]; }, "Not labeled for St. Augustine."],
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
    plan.warnings = [{ code: "missing_calibration", message: "No sprayer test on file for the selected tank, so tank amounts are not shown. Test the sprayer." }];
    const { container } = render(<ProtocolTankSheet plan={plan} />);
    expect(within(container).getByText(/needs its own tank. Do not combine those products in one tank/)).toBeInTheDocument();
    expect(within(container).getByText("No amount")).toBeInTheDocument();
    expect(within(container).getByText(/No sprayer test on file for the selected tank/)).toBeInTheDocument();
  });
});
