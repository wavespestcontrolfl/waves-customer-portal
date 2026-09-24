import { describe, expect, it } from "vitest";
import { removeConsultationClause } from "./composerLinks";

// Codex #4709 r20 P2: the remembered consultation clause is removed on a
// recipient/customer change even after the operator edited its link.
describe("removeConsultationClause", () => {
  const remembered = "Hi Jamie, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/token1 Reply STOP to opt out.";

  it("removes the remembered line verbatim, keeping the operator's own text", () => {
    expect(removeConsultationClause(`Running late!\n\n${remembered}`, remembered)).toBe("Running late!");
  });

  it("removes the clause after its link was edited (wording + host fallback)", () => {
    const edited = remembered.replace("token1", "tokenX1");
    expect(removeConsultationClause(`Running late!\n\n${edited}`, remembered)).toBe("Running late!");
  });

  it("removes a reworded clause that still carries the remembered link", () => {
    expect(removeConsultationClause("Book here: https://waves.link/l/token1\n\nThanks", remembered)).toBe("Thanks");
  });

  it("leaves a draft with no consultation clause untouched", () => {
    expect(removeConsultationClause("See you Tuesday — https://waves.link/l/other", remembered)).toBe("See you Tuesday — https://waves.link/l/other");
    expect(removeConsultationClause("Anything", null)).toBe("Anything");
  });
});
