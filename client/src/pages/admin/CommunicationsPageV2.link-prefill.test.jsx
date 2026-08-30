// @vitest-environment jsdom
// The link-insert buttons prefill an EMPTY composer with a personalized
// greeting (recipient first name + what the link covers); with no name the
// caller falls back to the bare server clause. Copy must stay plain ASCII —
// an em dash or curly quote flips the SMS to UCS-2 (70-char segments).
import { describe, expect, it } from "vitest";
import {
  appendStaticLinkClause,
  buildReschedulePrefill,
  buildReservicePrefill,
  STATIC_COMPOSER_LINKS,
} from "./CommunicationsPageV2";

const URL = "https://portal.wavespestcontrol.com/l/abc123";

describe("buildReschedulePrefill", () => {
  it("greets the recipient with the visit's day, service, and link", () => {
    expect(
      buildReschedulePrefill({
        firstName: "PersonA",
        day: "Mon, Aug 10",
        serviceType: "Quarterly Pest Control Service",
        url: URL,
      }),
    ).toBe(
      `Hi PersonA, it's Waves Pest Control. Reschedule your Mon, Aug 10 Quarterly Pest Control Service visit here: ${URL}`,
    );
  });

  it("drops the service segment when the visit has no service type", () => {
    expect(
      buildReschedulePrefill({
        firstName: "PersonA",
        day: "Mon, Aug 10",
        serviceType: null,
        url: URL,
      }),
    ).toBe(
      `Hi PersonA, it's Waves Pest Control. Reschedule your Mon, Aug 10 visit here: ${URL}`,
    );
  });

  it("returns null without a first name or url — the caller falls back to the clause", () => {
    expect(
      buildReschedulePrefill({ firstName: "", day: "Mon, Aug 10", url: URL }),
    ).toBeNull();
    expect(
      buildReschedulePrefill({ firstName: "  ", day: "Mon, Aug 10", url: URL }),
    ).toBeNull();
    expect(
      buildReschedulePrefill({ firstName: "PersonA", day: "Mon, Aug 10", url: null }),
    ).toBeNull();
  });

  it("keeps the TEMPLATE copy pure ASCII — no unicode punctuation of our own", () => {
    // With ASCII inputs the whole message must be ASCII: any non-ASCII char
    // would be template punctuation (em dash, curly quote) silently flipping
    // the SMS to UCS-2 (70-char segments).
    const msg = buildReschedulePrefill({
      firstName: "PersonA",
      day: "Mon, Aug 10",
      serviceType: "Quarterly Pest Control Service",
      url: URL,
    });

    expect(msg).toMatch(/^[\x00-\x7F]+$/);
  });

  it("passes non-ASCII dynamic values through untouched — Personé stays Personé", () => {
    expect(
      buildReschedulePrefill({
        firstName: "Personé",
        day: "Mon, Aug 10",
        serviceType: null,
        url: URL,
      }),
    ).toBe(`Hi Personé, it's Waves Pest Control. Reschedule your Mon, Aug 10 visit here: ${URL}`);
  });
});

describe("buildReservicePrefill", () => {
  it("greets the recipient with the covered lane and link", () => {
    expect(
      buildReservicePrefill({ firstName: "PersonA", laneLabel: "pest", url: URL }),
    ).toBe(
      `Hi PersonA, it's Waves Pest Control. Book your free pest re-service here: ${URL}`,
    );
  });

  it("reads cleanly without a lane label", () => {
    expect(
      buildReservicePrefill({ firstName: "PersonA", laneLabel: null, url: URL }),
    ).toBe(
      `Hi PersonA, it's Waves Pest Control. Book your free re-service here: ${URL}`,
    );
  });

  it("returns null without a first name", () => {
    expect(
      buildReservicePrefill({ firstName: null, laneLabel: "pest", url: URL }),
    ).toBeNull();
  });
});

// The Insert Link menu's evergreen entries (quote page, app store listings)
// share one append helper: clause alone into an empty composer, clause
// appended below a typed draft, and never a stacked duplicate.
describe("appendStaticLinkClause", () => {
  const link = STATIC_COMPOSER_LINKS.quote;

  it("an empty composer gets the clause alone", () => {
    expect(appendStaticLinkClause("", link)).toBe(link.clause);
    expect(appendStaticLinkClause("   ", link)).toBe(link.clause);
    expect(appendStaticLinkClause(null, link)).toBe(link.clause);
  });

  it("a typed draft keeps its text and gets the clause appended", () => {
    expect(appendStaticLinkClause("Hi PersonA, quick question.  ", link)).toBe(
      `Hi PersonA, quick question.\n\n${link.clause}`,
    );
  });

  it("does not stack a second copy of a link already in the body", () => {
    const once = appendStaticLinkClause("Hi PersonA.", link);
    expect(appendStaticLinkClause(once, link)).toBe(once);
  });
});

describe("STATIC_COMPOSER_LINKS", () => {
  it("carries the quote page and both app store listings", () => {
    expect(STATIC_COMPOSER_LINKS.quote.url).toBe(
      "https://www.wavespestcontrol.com/quote/",
    );
    expect(STATIC_COMPOSER_LINKS.appStore.url).toContain("apps.apple.com");
    expect(STATIC_COMPOSER_LINKS.playStore.url).toContain("play.google.com");
  });

  it("keeps every clause plain ASCII (UCS-2 guard) and carries its own URL", () => {
    for (const link of Object.values(STATIC_COMPOSER_LINKS)) {
      expect(link.clause).toMatch(/^[\x00-\x7F]+$/);
      expect(link.clause).toContain(link.url);
    }
  });
});
