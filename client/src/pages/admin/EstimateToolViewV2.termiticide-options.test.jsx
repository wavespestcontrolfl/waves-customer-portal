import { describe, expect, it } from "vitest";
import { termiticideProductOptions } from "./EstimateToolViewV2";

// bifen_it is the same Atticus Talak 7.9 F bottle as talstar_p (owner 2026-10-25), so the
// pre-slab and trenching dropdowns list Talak once; a saved bifen_it selection keeps a match.
describe("termiticide product options", () => {
  const values = (options) => options.map((o) => o.value);

  it("lists Talak once in both dropdowns for a new selection", () => {
    expect(values(termiticideProductOptions("preslab", "termidor_sc"))).toEqual(["termidor_sc", "taurus_sc", "talstar_p"]);
    expect(values(termiticideProductOptions("trenching", "taurus_sc"))).toEqual(["taurus_sc", "termidor_sc", "talstar_p"]);
    for (const kind of ["preslab", "trenching"]) {
      const talak = termiticideProductOptions(kind, "talstar_p").filter((o) => o.label.startsWith("Talak 7.9 F"));
      expect(talak).toHaveLength(1);
    }
  });

  it("keeps one matching Talak entry for a saved bifen_it selection", () => {
    for (const kind of ["preslab", "trenching"]) {
      const options = termiticideProductOptions(kind, "bifen_it");
      const match = options.filter((o) => o.value === "bifen_it");
      expect(match).toHaveLength(1);
      expect(match[0].label).toMatch(/^Talak 7\.9 F - Bifenthrin/);
    }
  });
});
