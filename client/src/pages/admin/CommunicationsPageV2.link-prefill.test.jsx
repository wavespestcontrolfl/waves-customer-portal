// @vitest-environment jsdom
// The link-insert buttons prefill an EMPTY composer with a personalized
// greeting (recipient first name + what the link covers); with no name the
// caller falls back to the bare server clause. Copy must stay plain ASCII —
// an em dash or curly quote flips the SMS to UCS-2 (70-char segments).
import { describe, expect, it } from "vitest";
import {
  reviewEmailNote,
  appendStaticLinkClause,
  buildCustomerLinkPrefill,
  buildReschedulePrefill,
  buildReservicePrefill,
  CUSTOMER_COMPOSER_LINKS,
  libraryLinkClause,
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

// The Insert Link sheet's static entries share one append helper: clause
// alone into an empty composer, clause appended below a typed draft, and
// never a stacked duplicate.
describe("appendStaticLinkClause", () => {
  const link = {
    url: "https://www.wavespestcontrol.com/quote/",
    clause: "Get your free quote here: https://www.wavespestcontrol.com/quote/",
  };

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

describe("libraryLinkClause", () => {
  it("renders '{clause}: {url}' and falls back to the row name", () => {
    expect(
      libraryLinkClause({ name: "Free quote", clause: "Get your free quote here", url: "https://www.wavespestcontrol.com/quote/" }),
    ).toBe("Get your free quote here: https://www.wavespestcontrol.com/quote/");
    expect(
      libraryLinkClause({ name: "Pest Library", clause: null, url: "https://www.wavespestcontrol.com/pest-library/" }),
    ).toBe("Pest Library: https://www.wavespestcontrol.com/pest-library/");
  });
});

describe("buildCustomerLinkPrefill", () => {
  it("greets the recipient ahead of the server clause", () => {
    expect(
      buildCustomerLinkPrefill({ firstName: "PersonA", clause: `You can view your estimate here: ${URL}` }),
    ).toBe(`Hi PersonA, it's Waves Pest Control. You can view your estimate here: ${URL}`);
  });

  it("returns null without a first name or clause — caller falls back to the bare clause", () => {
    expect(buildCustomerLinkPrefill({ firstName: "", clause: `x: ${URL}` })).toBeNull();
    expect(buildCustomerLinkPrefill({ firstName: "PersonA", clause: "  " })).toBeNull();
  });

  it("keeps the TEMPLATE copy pure ASCII (UCS-2 guard)", () => {
    const msg = buildCustomerLinkPrefill({ firstName: "PersonA", clause: `Pay here: ${URL}` });
    expect(msg).toMatch(/^[\x00-\x7F]+$/);
  });
});

describe("CUSTOMER_COMPOSER_LINKS", () => {
  it("carries all seventeen customer rows in the customer category", () => {
    expect(CUSTOMER_COMPOSER_LINKS.map((l) => l.key)).toEqual([
      "reschedule",
      "reservice",
      "review_request",
      "pay_balance",
      "estimate",
      "referral",
      "autopay_setup",
      "appointment",
      "card_request",
      "prep_guide",
      "service_report",
      "contract",
      "statement",
      "project_report",
      "portal_login",
      "cancel_plan",
    ]);
    for (const link of CUSTOMER_COMPOSER_LINKS) {
      expect(link.category).toBe("customer");
    }
    // The one static row inserts a scheme-less portal link (SMS link policy
    // for owned hosts) and carries its clause with it.
    const login = CUSTOMER_COMPOSER_LINKS.find((l) => l.key === "portal_login");
    expect(login.dynamic).toBeUndefined();
    expect(login.url).toBe("portal.wavespestcontrol.com/login");
    // Cancellation lands IN the portal (owner ruling 2026-09-03): a static
    // login link whose post-login destination is the My Plan tab, where the
    // cancel flow lives — no public /cancel route, no server mint.
    const cancel = CUSTOMER_COMPOSER_LINKS.find((l) => l.key === "cancel_plan");
    expect(cancel.dynamic).toBeUndefined();
    expect(cancel.url).toBe("portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dplan");
    expect(new URLSearchParams(cancel.url.split("?")[1]).get("next")).toBe("/?tab=plan");
  });

  it("only the review request row asks for a channel (Text / Email / Both)", () => {
    const withChooser = CUSTOMER_COMPOSER_LINKS.filter((l) => l.channels).map((l) => l.key);
    expect(withChooser).toEqual(["review_request"]);
  });
});

describe("reviewEmailNote", () => {
  it("is silent for a Text-only send and names the outcome of a Both send", () => {
    expect(reviewEmailNote(undefined)).toBe("");
    expect(reviewEmailNote({ sent: true })).toBe(" Review request emailed too.");
    expect(reviewEmailNote({ sent: false, reason: "email_off" })).toMatch(/skipped — review emails are off/);
    expect(reviewEmailNote({ sent: false, reason: "no_email" })).toMatch(/no email on file/);
    expect(reviewEmailNote({ sent: false, reason: "text_not_sent" })).toMatch(/text did not go out/);
    expect(reviewEmailNote({ sent: false, reason: "email_uncertain" })).toMatch(/may or may not have gone out — check the customer's email log/);
    expect(reviewEmailNote({ sent: false, reason: "already_reviewed" })).toMatch(/already marked as having left a review/);
    expect(reviewEmailNote({ sent: false, reason: "something_new" })).toMatch(/could not be sent/);
  });
});
