import { describe, expect, it } from "vitest";
import { palmPrefillAllowed } from "./lookupPrefill";

describe("palm-count prefill gate", () => {
  it("prefills a server-trusted count", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 7, palmCountTrusted: true })).toBe(true);
  });

  it("suppresses an affirmatively distrusted count — the operator counts instead", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 9, palmCountTrusted: false })).toBe(false);
  });

  it("keeps the pre-existing prefill for legacy payloads with no verdict", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 7 })).toBe(true);
  });

  it("never prefills without a positive count", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 0, palmCountTrusted: true })).toBe(false);
    expect(palmPrefillAllowed(null)).toBe(false);
  });
});
