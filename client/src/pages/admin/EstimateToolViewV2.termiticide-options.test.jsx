import { describe, expect, it } from "vitest";
import { termiticideProductOptions } from "./EstimateToolViewV2";

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
