import { describe, expect, it } from "vitest";
import { BIFENTHRIN_LABEL_BOTTLE, canonicalTermiticideFields, clearPriorBottleLabelChecks, termiticideProductOptions } from "./EstimateToolViewV2";

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
  const saved = (extra) => ({
    svcPreslab: true, preslabProductKey: "talstar_p", preslabLabelConfirmed: true,
    svcTrenching: true, trenchingProductKey: "bifen_it", trenchingLabelConfirmed: true, ...extra,
  });

  // Every form a reopen restores carries today's bottle mark, so a check ticked after the reopen counts (pre-push audit 22).
  const mark = { _bifenthrinLabelBottle: BIFENTHRIN_LABEL_BOTTLE };

  it("clears both bifenthrin label checks on a form saved without the bottle mark", () => {
    const inputs = saved();
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, { ...inputs, notes: "kept" });
    expect(cleared).toEqual(["pre-slab", "trenching"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false, preslabProductKey: "talstar_p", trenchingProductKey: "bifen_it", notes: "kept", ...mark });
  });

  // A deselected service keeps its fields. Its check is cleared as well, but only a selected service's check sends the estimate
  // back to Generate: the saved price does not include a deselected service (pre-push audit 29).
  it("clears a deselected service's check without naming it, so it does not send the estimate back to Generate", () => {
    const trenchOnly = saved({ svcPreslab: false });
    expect(clearPriorBottleLabelChecks(trenchOnly, trenchOnly)).toEqual({
      form: { ...trenchOnly, preslabLabelConfirmed: false, trenchingLabelConfirmed: false, ...mark }, cleared: ["trenching"],
    });
    const pestOnly = saved({ svcPest: true, svcPreslab: false, svcTrenching: false });
    expect(clearPriorBottleLabelChecks(pestOnly, pestOnly)).toEqual({
      form: { ...pestOnly, preslabLabelConfirmed: false, trenchingLabelConfirmed: false, ...mark }, cleared: [],
    });
  });

  it("keeps the checks a form made for Crosscheck Plus, and fipronil checks, and unchecked boxes", () => {
    const marked = saved(mark);
    const same = clearPriorBottleLabelChecks(marked, marked);
    expect(same).toEqual({ form: marked, cleared: [] });
    expect(same.form).toBe(marked); // a form already marked comes back as is
    const fipronil = saved({ preslabProductKey: "termidor_sc", trenchingProductKey: "taurus_sc" });
    expect(clearPriorBottleLabelChecks(fipronil, fipronil)).toEqual({ form: { ...fipronil, ...mark }, cleared: [] });
    const unchecked = saved({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false });
    expect(clearPriorBottleLabelChecks(unchecked, unchecked)).toEqual({ form: { ...unchecked, ...mark }, cleared: [] });
    const form = { preslabProductKey: "talstar_p", preslabLabelConfirmed: true };
    expect(clearPriorBottleLabelChecks(null, form)).toEqual({ form: { ...form, ...mark }, cleared: [] });
  });

  it("replaces a saved null or an earlier bottle's mark with today's, whether or not a check was cleared", () => {
    for (const earlier of [null, "atticus_talak"]) {
      const checked = saved({ _bifenthrinLabelBottle: earlier });
      expect(clearPriorBottleLabelChecks(checked, checked)).toEqual({
        form: { ...checked, preslabLabelConfirmed: false, trenchingLabelConfirmed: false, ...mark }, cleared: ["pre-slab", "trenching"],
      });
      const clear = saved({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false, _bifenthrinLabelBottle: earlier });
      expect(clearPriorBottleLabelChecks(clear, clear)).toEqual({ form: { ...clear, ...mark }, cleared: [] });
    }
  });

  it("resolves a saved alias such as talak or Crosscheck Plus to its key before it decides, fipronil aliases included", () => {
    const inputs = saved({ preslabProductKey: "talak", trenchingProductKey: "Crosscheck Plus" });
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, inputs);
    expect(cleared).toEqual(["pre-slab", "trenching"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: false, preslabProductKey: "talak" });
    const fipronil = saved({ preslabProductKey: "termidor", trenchingProductKey: "taurus" });
    expect(clearPriorBottleLabelChecks(fipronil, fipronil)).toEqual({ form: { ...fipronil, ...mark }, cleared: [] });
  });

  it("restores a saved alias as its option key, so the picker and the label panel show the product the engine prices", () => {
    expect(canonicalTermiticideFields({ preslabProductKey: "talak", trenchingProductKey: "Crosscheck Plus", notes: "kept" }))
      .toEqual({ preslabProductKey: "talstar_p", trenchingProductKey: "talstar_p", notes: "kept" });
    expect(canonicalTermiticideFields({ preslabProductKey: "termidor", trenchingProductKey: "taurus" }))
      .toEqual({ preslabProductKey: "termidor_sc", trenchingProductKey: "taurus_sc" });
    expect(canonicalTermiticideFields({ preslabProductKey: "Cross Check Plus", trenchingProductKey: "LESCO Cross Check Plus" }))
      .toEqual({ preslabProductKey: "talstar_p", trenchingProductKey: "talstar_p" });
    const keys = { preslabProductKey: "talstar_p", trenchingProductKey: "" };
    expect(canonicalTermiticideFields(keys)).toBe(keys);
    const unknown = { preslabProductKey: "mystery bottle", trenchingProductKey: "bifen_it" };
    expect(canonicalTermiticideFields(unknown)).toBe(unknown);
    // An inherited key is no alias: a saved "constructor" stays a string, so Generate still sends it and the server holds it for
    // review (pre-push audit at the thirteenth push).
    const inherited = { preslabProductKey: "constructor", trenchingProductKey: "Constructor" };
    expect(canonicalTermiticideFields(inherited)).toBe(inherited);
  });

  // The server reads a trenching rate alias as "standard" or "high" by its own token rules, so a reopen shows that rate in the picker
  // and the label box (pre-push audit 31).
  it("restores a saved trenching rate alias as the rate the server reads", () => {
    for (const [saved, rate] of [["high_rate", "high"], ["0.125%", "high"], ["Problem Soil", "high"], ["Regular", "standard"], ["0.06%", "standard"]]) {
      expect(canonicalTermiticideFields({ trenchingApplicationRate: saved, notes: "kept" })).toEqual({ trenchingApplicationRate: rate, notes: "kept" });
    }
    for (const asSaved of [{ trenchingApplicationRate: "high" }, { trenchingApplicationRate: "extreme" }, { trenchingApplicationRate: "constructor" }, { trenchingApplicationRate: "" }]) {
      expect(canonicalTermiticideFields(asSaved)).toBe(asSaved);
    }
  });

  it("keeps a pre-slab ingredient name as saved, so the server still holds it for review; trenching resolves it", () => {
    expect(canonicalTermiticideFields({ preslabProductKey: "bifenthrin", trenchingProductKey: "bifenthrin" }))
      .toEqual({ preslabProductKey: "bifenthrin", trenchingProductKey: "bifen_it" });
    expect(canonicalTermiticideFields({ preslabProductKey: " Fipronil ", trenchingProductKey: "fipronil" }))
      .toEqual({ preslabProductKey: " Fipronil ", trenchingProductKey: "taurus_sc" });
  });

  it("clears only the bifenthrin check when the other key is fipronil", () => {
    const inputs = saved({ trenchingProductKey: "taurus_sc" });
    const { form, cleared } = clearPriorBottleLabelChecks(inputs, inputs);
    expect(cleared).toEqual(["pre-slab"]);
    expect(form).toMatchObject({ preslabLabelConfirmed: false, trenchingLabelConfirmed: true });
  });
});
