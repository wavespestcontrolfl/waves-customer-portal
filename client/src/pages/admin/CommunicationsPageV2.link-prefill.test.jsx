// @vitest-environment jsdom
// The link-insert buttons prefill an EMPTY composer with a personalized
// greeting (recipient first name + what the link covers); with no name the
// caller falls back to the bare server clause. Copy must stay plain ASCII —
// an em dash or curly quote flips the SMS to UCS-2 (70-char segments).
import { describe, expect, it } from "vitest";
import {
  buildReschedulePrefill,
  buildReservicePrefill,
} from "./CommunicationsPageV2";

const URL = "https://portal.wavespestcontrol.com/l/abc123";

describe("buildReschedulePrefill", () => {
  it("greets the recipient with the visit's day, service, and link", () => {
    expect(
      buildReschedulePrefill({
        firstName: "Krista",
        day: "Mon, Aug 10",
        serviceType: "Quarterly Pest Control Service",
        url: URL,
      }),
    ).toBe(
      `Hi Krista, it's Waves Pest Control. Reschedule your Mon, Aug 10 Quarterly Pest Control Service visit here: ${URL}`,
    );
  });

  it("drops the service segment when the visit has no service type", () => {
    expect(
      buildReschedulePrefill({
        firstName: "Krista",
        day: "Mon, Aug 10",
        serviceType: null,
        url: URL,
      }),
    ).toBe(
      `Hi Krista, it's Waves Pest Control. Reschedule your Mon, Aug 10 visit here: ${URL}`,
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
      buildReschedulePrefill({ firstName: "Krista", day: "Mon, Aug 10", url: null }),
    ).toBeNull();
  });

  it("stays pure GSM-7 — no unicode punctuation sneaks into the segment math", () => {
    const msg = buildReschedulePrefill({
      firstName: "Krista",
      day: "Mon, Aug 10",
      serviceType: "Quarterly Pest Control Service",
      url: URL,
    });
     
    expect(msg).toMatch(/^[\x00-\x7F]+$/);
  });
});

describe("buildReservicePrefill", () => {
  it("greets the recipient with the covered lane and link", () => {
    expect(
      buildReservicePrefill({ firstName: "Krista", laneLabel: "pest", url: URL }),
    ).toBe(
      `Hi Krista, it's Waves Pest Control. Book your free pest re-service here: ${URL}`,
    );
  });

  it("reads cleanly without a lane label", () => {
    expect(
      buildReservicePrefill({ firstName: "Krista", laneLabel: null, url: URL }),
    ).toBe(
      `Hi Krista, it's Waves Pest Control. Book your free re-service here: ${URL}`,
    );
  });

  it("returns null without a first name", () => {
    expect(
      buildReservicePrefill({ firstName: null, laneLabel: "pest", url: URL }),
    ).toBeNull();
  });
});
