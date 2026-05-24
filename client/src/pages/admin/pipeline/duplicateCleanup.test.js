import { describe, expect, it } from "vitest";
import { defaultCandidateId, rankCandidateMatches, scoreCandidateMatch } from "./duplicateCleanup";

describe("duplicate cleanup candidate scoring", () => {
  const estimate = {
    phone: "(555) 123-4567",
    email: "Customer@Example.com",
    address: "123 Main St",
  };

  it("scores exact phone and email matches as high confidence", () => {
    const match = scoreCandidateMatch(estimate, {
      phone: "5551234567",
      email: "customer@example.com",
    });

    expect(match).toMatchObject({
      exactPhone: true,
      exactEmail: true,
      highConfidence: true,
    });
    expect(match.score).toBe(8);
  });

  it("does not mark already-linked leads as high confidence", () => {
    const match = scoreCandidateMatch(estimate, {
      phone: "5551234567",
      email: "customer@example.com",
      estimateId: "est-old",
    });

    expect(match.alreadyLinked).toBe(true);
    expect(match.highConfidence).toBe(false);
  });

  it("does not treat matching partial phone numbers as exact", () => {
    const match = scoreCandidateMatch(
      { phone: "1234" },
      { phone: "1234" },
    );

    expect(match.exactPhone).toBe(false);
    expect(match.highConfidence).toBe(false);
  });

  it("preselects the strongest unlinked exact match", () => {
    const ranked = rankCandidateMatches(estimate, [
      { leadId: "name-only", name: "Customer Example" },
      { leadId: "linked", phone: "5551234567", estimateId: "est-old" },
      { leadId: "exact", phone: "5551234567" },
    ]);

    expect(ranked[0].leadId).toBe("exact");
    expect(defaultCandidateId(estimate, ranked)).toBe("exact");
  });

  it("does not preselect name-only candidates", () => {
    expect(defaultCandidateId(estimate, [{ leadId: "name-only", name: "Customer Example" }])).toBe("");
  });
});
