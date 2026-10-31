import { describe, expect, it } from "vitest";
import { leadServiceAddress } from "./format-address";

// Streets are invented; the shapes are the ones leads.address holds in prod.
describe("leadServiceAddress", () => {
  it("adds the lead's own city, FL and ZIP to a bare street line", () => {
    expect(leadServiceAddress({ address: "100 Test Palm Way", city: "Parrish", zip: "34219" }))
      .toBe("100 Test Palm Way, Parrish, FL 34219");
    expect(leadServiceAddress({ address: "100 Test Palm Way, Unit 101", city: "Parrish", zip: "34219" }))
      .toBe("100 Test Palm Way, Unit 101, Parrish, FL 34219");
    expect(leadServiceAddress({ address: "100 Test Palm Way", city: "Parrish", zip: null }))
      .toBe("100 Test Palm Way, Parrish, FL");
    expect(leadServiceAddress({ address: "100 Test Palm Way", city: null, zip: "34219" }))
      .toBe("100 Test Palm Way, FL 34219");
  });

  it("keeps a web-form line that already names its locality", () => {
    for (const address of [
      "100 Test Palm Way, Parrish, FL 34219",
      "100 Test Palm Way, Parrish, FL",
      "100 Test Palm Way Parrish FL 34219-1234",
      "100 Test Palm Way, Parrish, FL 34219, United States of America",
    ]) {
      expect(leadServiceAddress({ address, city: "Parrish", zip: "34219" })).toBe(address);
    }
  });

  it("does not read a 5-digit unit as a ZIP, or repeat a city the line ends with", () => {
    expect(leadServiceAddress({ address: "100 Test Palm Way, Apt 12345", city: "Parrish", zip: "34219" }))
      .toBe("100 Test Palm Way, Apt 12345, Parrish, FL 34219");
    expect(leadServiceAddress({ address: "100 Test Palm Way, parrish", city: "Parrish", zip: "34219" }))
      .toBe("100 Test Palm Way, parrish, FL 34219");
  });

  it("returns the line unchanged with no city or ZIP, and empty with no line", () => {
    expect(leadServiceAddress({ address: " 100 Test Palm Way ", city: "", zip: null })).toBe("100 Test Palm Way");
    expect(leadServiceAddress({ address: null, city: "Parrish", zip: "34219" })).toBe("");
    expect(leadServiceAddress(null)).toBe("");
  });
});
