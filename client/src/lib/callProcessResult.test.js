import { describe, it, expect } from "vitest";
import { describeProcessResult } from "./callProcessResult";

describe("describeProcessResult", () => {
  it("a blocked claim is NOT success — it is 200 OK with nothing done", () => {
    // The exact shape the route returned when the owner hit Process on a
    // wedged call on 2026-08-31 and believed it had run.
    const v = describeProcessResult({
      success: true,
      skipped: true,
      reason: "already_processing",
    });
    expect(v.didWork).toBe(false);
    expect(v.severity).toBe("blocked");
    expect(v.text).toMatch(/Nothing ran/);
  });

  it("an unrecognised skip fails closed as blocked", () => {
    const v = describeProcessResult({ success: true, skipped: true, reason: "brand_new_reason" });
    expect(v.didWork).toBe(false);
    expect(v.severity).toBe("blocked");
    expect(v.text).toContain("brand_new_reason");
  });

  it("a skip with no reason at all is still blocked, never success", () => {
    const v = describeProcessResult({ success: true, skipped: true });
    expect(v.severity).toBe("blocked");
  });

  it("skips that reached a real outcome read as done", () => {
    for (const reason of ["already_processed", "spam", "voicemail", "pan_quarantined"]) {
      const v = describeProcessResult({ success: true, skipped: true, reason });
      expect(v.didWork).toBe(true);
      expect(v.severity).toBe("ok");
    }
  });

  it("a policy hold reads as processed-and-held, not as nothing-ran", () => {
    // The server persists the extraction, a terminal status and an open
    // review on this path; only the canonical writes are withheld. Saying
    // "nothing was saved" would invite a pointless reprocess.
    const v = describeProcessResult({ success: true, skipped: true, reason: "v2_canonical_write_blocked" });
    expect(v.didWork).toBe(true);
    expect(v.severity).toBe("ok");
    expect(v.text).toMatch(/held for review/);
  });

  it("a hard failure is failed, not blocked", () => {
    const v = describeProcessResult({ success: false, error: "openai timeout" });
    expect(v.severity).toBe("failed");
    expect(v.text).toContain("openai timeout");
  });

  it("recording_not_ready is success:false + skipped — still blocked, not failed", () => {
    const v = describeProcessResult({ success: false, skipped: true, reason: "recording_not_ready" });
    expect(v.severity).toBe("blocked");
    expect(v.text).toMatch(/hasn't landed/);
  });

  it("a real run summarises what was extracted", () => {
    const v = describeProcessResult({
      success: true,
      extracted: { first_name: "Jane", last_name: "Doe", email: "j@example.com", address_line1: "1 Main St" },
    });
    expect(v.didWork).toBe(true);
    expect(v.severity).toBe("ok");
    expect(v.text).toBe("Processed — Name: Jane Doe · Email: j@example.com · Address: 1 Main St");
  });

  it("a run with nothing extracted still reads as processed", () => {
    expect(describeProcessResult({ success: true }).text).toBe("Processed");
  });

  it("a null/undefined body is treated as a plain run, not a crash", () => {
    expect(describeProcessResult(null).severity).toBe("ok");
  });
});
