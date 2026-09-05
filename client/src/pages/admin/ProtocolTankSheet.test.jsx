// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProtocolTankSheet from "./ProtocolTankSheet";

const calibration = { id: "cal-1", calibration_status: "field_verified" };
function fixture() {
  return {
    month: "Sep",
    equipment: { calibrationId: "cal-1", systemName: "Test tank", tankCapacityGal: 110, carrierGalPer1000: 2, tankCoverageSqft: 55000 },
    items: [{
      selected: true,
      fullTankMix: { amount: 12.5, amountUnit: "oz" },
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
    const { container } = render(<ProtocolTankSheet plan={plan} calibration={calibration} />);
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
    const { container } = render(<ProtocolTankSheet plan={plan} calibration={calibration} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Product label")).toHaveAttribute("href", "https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102::::::P102_REG_NUM:123-456-789");
      expect(within(surface).queryByText("Product label document not on file")).not.toBeInTheDocument();
    }
  });

  it("preserves product-specific triggers and application scope on screen and in print", () => {
    const plan = fixture();
    Object.assign(plan.items[0], { conditional: true, raw: "Spot treat only if the synthetic threshold is met", scope: "spot" });
    const { container } = render(<ProtocolTankSheet plan={plan} calibration={calibration} />);
    for (const surface of [container, document.querySelector(".protocol-print-sheet")]) {
      expect(within(surface).getByText("Spot treat only if the synthetic threshold is met")).toBeInTheDocument();
      expect(within(surface).getByText("Application scope")).toBeInTheDocument();
      expect(within(surface).getByText("spot")).toBeInTheDocument();
      expect(within(surface).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    }
  });

  it("uses the server tank amount and includes safety documents in the printable sheet", () => {
    const { container } = render(<ProtocolTankSheet plan={fixture()} calibration={calibration} safetyRules={["Test seasonal restriction"]} />);
    expect(within(container).getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    const printed = within(document.querySelector(".protocol-print-sheet"));
    expect(printed.getByText("12.5 oz / 110 gal")).toBeInTheDocument();
    expect(printed.getByText("chemical gloves")).toBeInTheDocument();
    expect(printed.getByText("Test compatibility restriction")).toBeInTheDocument();
    expect(printed.getByText("Test seasonal restriction")).toBeInTheDocument();
    expect(printed.getByText("Product label")).toHaveAttribute("href", "https://example.com/label.pdf");
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Print mixing reference" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it.each([
    ["different tank", (p) => { p.equipment.tankCapacityGal = 4; }, calibration],
    ["expired calibration", (p) => { p.equipment.expiresAt = new Date(Date.now() - 60000).toISOString(); }, calibration],
    ["unverified calibration", () => {}, { ...calibration, calibration_status: "estimated" }],
    ["mismatched calibration", () => {}, { ...calibration, id: "other" }],
    ["unverified label", (p) => { p.items[0].product.labelVerifiedAt = null; }, calibration],
    ["non-tank product", (p) => { p.items[0].product.mixingOrderCategory = "granular"; }, calibration],
    ["excluded St. Augustine", (p) => { p.items[0].product.excludedTurfSpecies = ["St. Augustine"]; }, calibration],
    ["unknown St. Augustine cultivar", (p) => { p.items[0].product.excludedTurfSpecies = ["floratam", "bitterblue", "st_augustine_unknown_cultivar"]; }, calibration],
    ["unselected conditional", (p) => { p.items[0].selected = false; p.items[0].conditional = true; p.items[0].plannedFullTankMix = p.items[0].fullTankMix; }, calibration],
    ["missing unit", (p) => { p.items[0].fullTankMix.amountUnit = null; }, calibration],
  ])("withholds quantities for %s", (_name, change, selectedCalibration) => {
    const plan = fixture();
    change(plan);
    const { container } = render(<ProtocolTankSheet plan={plan} calibration={selectedCalibration} />);
    expect(within(container).queryByText("12.5 oz / 110 gal")).not.toBeInTheDocument();
    expect(within(container).getByText("Quantity withheld")).toBeInTheDocument();
    expect(within(document.querySelector(".protocol-print-sheet")).queryByText("12.5 oz / 110 gal")).not.toBeInTheDocument();
  });
});
