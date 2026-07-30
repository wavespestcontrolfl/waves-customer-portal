// @vitest-environment jsdom
// The Communications usage-beacon leaf must always be slug-shaped (the
// tracking pipeline rejects underscores as identifier-ish), and the
// Templates tab reports its DEEPEST rendered sub-view (Codex #2961 r14).
import { describe, expect, it } from "vitest";
import { usageLeafFor } from "./CommunicationsPageV2";

describe("usageLeafFor", () => {
  it("passes plain tab keys through", () => {
    expect(usageLeafFor("sms", "sms")).toBe("sms");
    expect(usageLeafFor("events", "sms")).toBe("events");
    expect(usageLeafFor("triage", "email")).toBe("triage");
  });

  it("canonicalizes underscore keys to the hyphenated slug shape", () => {
    expect(usageLeafFor("call_routing", "sms")).toBe("call-routing");
  });

  it("reports the rendered Templates sub-view as the leaf", () => {
    expect(usageLeafFor("templates", "sms")).toBe("templates");
    expect(usageLeafFor("templates", "email")).toBe("email-templates");
  });
});
