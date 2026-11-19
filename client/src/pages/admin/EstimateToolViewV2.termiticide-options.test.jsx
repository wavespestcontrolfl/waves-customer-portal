import { describe, expect, it } from "vitest";
import { BIFENTHRIN_LABEL_BOTTLE, canonicalTermiticideProducts, clearPriorBottleLabelChecks, termiticideProductOptions } from "./EstimateToolViewV2";

// bifen_it is the same bottle as talstar_p (owner 2026-10-25; LESCO Crosscheck Plus since 2026-11-18), so the
// pre-slab and trenching dropdowns list the bottle once (LESCO Crosscheck Plus since 2026-11-18); a saved bifen_it selection keeps a match.
describe("termiticide product options", () => {
  const values = (options) => options.map((o) => o.value);

  it("lists Crosscheck Plus once in both dropdowns for a new selection", () => {
    expect(values(termiticideProductOptions("preslab", "termidor_sc"))).toEqual(["termidor_sc", "taurus_sc", "talstar_p"]);
    expect(values(termiticideProductOptions("trenching", "taurus_sc"))).toEqual(["taurus_sc", "termidor_sc", "talstar_p"]);
    for (const kind of ["preslab", "trenching"]) {
      const crosscheck = termiticideProductOptions(kind, "talstar_p").filter((o) => o.label.startsWith("Crosscheck Plus"));
      expect(crosscheck).toHaveLength(1);
    }
  });

  it("keeps one matching Crosscheck Plus entry for a saved bifen_it selection", () => {
    for (const kind of ["preslab", "trenching"]) {
      const options = termiticideProductOptions(kind, "bifen_it");
      const match = options.filter((o) => o.value === "bifen_it");
      expect(match).toHaveLength(1);
      expect(match[0].label).toMatch(/^Crosscheck Plus - Bifenthrin/);
    }
  });
});

// A label check saved before the swap was made for the earlier bottle under the same key, so a reopen clears it.
describe("label checks saved for the earlier bifenthrin bottle", () => {
  const saved = (extra) => ({ preslabProductKey: "talstar_p", preslabLabelConfirmed: true, trenchingProductKey: "bifen_it", trenchingLabelConfirmed: true, ...extra });

  it("clears both bifenthrin label checks on a form saved without the bottle mark", () => {
    const inputs = saved();
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, { ...inputs, notes: "kept" });
    expect(cleared).toEqual(["pre-slab", "trenching"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false, preslabProductKey: "talstar_p", trenchingProductKey: "bifen_it", notes: "kept" });
  });

  it("keeps the checks a form made for Crosscheck Plus, and fipronil checks, and unchecked boxes", () => {
    const marked = saved({ _bifenthrinLabelBottle: BIFENTHRIN_LABEL_BOTTLE });
    expect(clearPriorBottleLabelChecks(marked, marked)).toEqual({ form: marked, cleared: [] });
    const fipronil = saved({ preslabProductKey: "termidor_sc", trenchingProductKey: "taurus_sc" });
    expect(clearPriorBottleLabelChecks(fipronil, fipronil)).toEqual({ form: fipronil, cleared: [] });
    const unchecked = saved({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false });
    expect(clearPriorBottleLabelChecks(unchecked, unchecked)).toEqual({ form: unchecked, cleared: [] });
    const form = { preslabProductKey: "talstar_p", preslabLabelConfirmed: true };
    expect(clearPriorBottleLabelChecks(null, form)).toEqual({ form, cleared: [] });
  });

  it("resolves a saved alias such as talak or Crosscheck Plus to its key before it decides, fipronil aliases included", () => {
    const inputs = saved({ preslabProductKey: "talak", trenchingProductKey: "Crosscheck Plus" });
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, inputs);
    expect(cleared).toEqual(["pre-slab", "trenching"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false, preslabProductKey: "talak" });
    const fipronil = saved({ preslabProductKey: "termidor", trenchingProductKey: "taurus" });
    expect(clearPriorBottleLabelChecks(fipronil, fipronil)).toEqual({ form: fipronil, cleared: [] });
  });

  it("restores a saved alias as its option key, so the picker and the label panel show the product the engine prices", () => {
    expect(canonicalTermiticideProducts({ preslabProductKey: "talak", trenchingProductKey: "Crosscheck Plus", notes: "kept" }))
      .toEqual({ preslabProductKey: "talstar_p", trenchingProductKey: "talstar_p", notes: "kept" });
    expect(canonicalTermiticideProducts({ preslabProductKey: "termidor", trenchingProductKey: "taurus" }))
      .toEqual({ preslabProductKey: "termidor_sc", trenchingProductKey: "taurus_sc" });
    expect(canonicalTermiticideProducts({ preslabProductKey: "Cross Check Plus", trenchingProductKey: "LESCO Cross Check Plus" }))
      .toEqual({ preslabProductKey: "talstar_p", trenchingProductKey: "talstar_p" });
    const keys = { preslabProductKey: "talstar_p", trenchingProductKey: "" };
    expect(canonicalTermiticideProducts(keys)).toBe(keys);
    const unknown = { preslabProductKey: "mystery bottle", trenchingProductKey: "bifen_it" };
    expect(canonicalTermiticideProducts(unknown)).toBe(unknown);
  });

  it("keeps a pre-slab ingredient name as saved, so the server still holds it for review; trenching resolves it", () => {
    expect(canonicalTermiticideProducts({ preslabProductKey: "bifenthrin", trenchingProductKey: "bifenthrin" }))
      .toEqual({ preslabProductKey: "bifenthrin", trenchingProductKey: "bifen_it" });
    expect(canonicalTermiticideProducts({ preslabProductKey: " Fipronil ", trenchingProductKey: "fipronil" }))
      .toEqual({ preslabProductKey: " Fipronil ", trenchingProductKey: "taurus_sc" });
  });

  it("clears only the bifenthrin check when the other key is fipronil", () => {
    const inputs = saved({ trenchingProductKey: "taurus_sc" });
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, inputs);
    expect(cleared).toEqual(["pre-slab"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: true });
  });
});
