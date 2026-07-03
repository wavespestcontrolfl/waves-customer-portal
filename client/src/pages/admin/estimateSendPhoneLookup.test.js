import { describe, it, expect } from "vitest";
import {
  normalizePhoneDigits,
  mergePhoneLookupMatch,
} from "./estimateSendPhoneLookup";

describe("normalizePhoneDigits", () => {
  it("strips formatting characters", () => {
    expect(normalizePhoneDigits("(941) 555-1234")).toBe("9415551234");
  });

  it("drops a leading 1 on an 11-digit number", () => {
    expect(normalizePhoneDigits("1-941-555-1234")).toBe("9415551234");
  });

  it("caps at 10 digits", () => {
    expect(normalizePhoneDigits("94155512345678")).toBe("9415551234");
  });

  it("handles empty/undefined input", () => {
    expect(normalizePhoneDigits("")).toBe("");
    expect(normalizePhoneDigits(undefined)).toBe("");
  });
});

describe("mergePhoneLookupMatch", () => {
  const match = {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
  };

  it("fills empty name and email from the match", () => {
    const { updates, autoFill, changed } = mergePhoneLookupMatch(
      { customerName: "", customerEmail: "" },
      match,
      { name: null, email: null },
    );
    expect(changed).toBe(true);
    expect(updates).toEqual({
      customerName: "Jane Doe",
      customerEmail: "jane@example.com",
    });
    expect(autoFill).toEqual({ name: "Jane Doe", email: "jane@example.com" });
  });

  it("never clobbers an operator-entered name or email", () => {
    const { updates, changed } = mergePhoneLookupMatch(
      { customerName: "Bob Smith", customerEmail: "bob@lead.com" },
      match,
      { name: null, email: null },
    );
    expect(changed).toBe(false);
    expect(updates).toEqual({});
  });

  it("never wipes a prefilled lead email when the match has no email on file", () => {
    const { updates } = mergePhoneLookupMatch(
      { customerName: "", customerEmail: "lead@prefill.com" },
      { firstName: "Jane", lastName: "Doe", email: null },
      { name: null, email: null },
    );
    expect(updates).toEqual({ customerName: "Jane Doe" });
  });

  it("replaces a previous auto-fill when the number changes to another customer", () => {
    const prevAuto = { name: "Jane Doe", email: "jane@example.com" };
    const { updates, autoFill } = mergePhoneLookupMatch(
      { customerName: "Jane Doe", customerEmail: "jane@example.com" },
      { firstName: "Bob", lastName: "Smith", email: "bob@example.com" },
      prevAuto,
    );
    expect(updates).toEqual({
      customerName: "Bob Smith",
      customerEmail: "bob@example.com",
    });
    expect(autoFill).toEqual({ name: "Bob Smith", email: "bob@example.com" });
  });

  it("clears an auto-filled email when the new match has none (no cross-customer pairing)", () => {
    const prevAuto = { name: "Jane Doe", email: "jane@example.com" };
    const { updates } = mergePhoneLookupMatch(
      { customerName: "Jane Doe", customerEmail: "jane@example.com" },
      { firstName: "Bob", lastName: "Smith", email: "" },
      prevAuto,
    );
    expect(updates).toEqual({ customerName: "Bob Smith", customerEmail: "" });
  });

  it("keeps a hand-edited field even when its sibling was auto-filled", () => {
    const prevAuto = { name: "Jane Doe", email: "jane@example.com" };
    const { updates } = mergePhoneLookupMatch(
      // Operator corrected the name after auto-fill; email untouched.
      { customerName: "Jane Doe-Corrected", customerEmail: "jane@example.com" },
      { firstName: "Bob", lastName: "Smith", email: "bob@example.com" },
      prevAuto,
    );
    expect(updates).toEqual({ customerEmail: "bob@example.com" });
  });

  it("does not write an empty name when the match has blank names", () => {
    const { updates, changed } = mergePhoneLookupMatch(
      { customerName: "", customerEmail: "" },
      { firstName: "", lastName: "", email: "solo@example.com" },
      { name: null, email: null },
    );
    expect(changed).toBe(true);
    expect(updates).toEqual({ customerEmail: "solo@example.com" });
  });

  it("reports changed=false when the form already matches", () => {
    const { changed, updates } = mergePhoneLookupMatch(
      { customerName: "Jane Doe", customerEmail: "jane@example.com" },
      match,
      { name: "Jane Doe", email: "jane@example.com" },
    );
    expect(changed).toBe(false);
    expect(updates).toEqual({});
  });
});
