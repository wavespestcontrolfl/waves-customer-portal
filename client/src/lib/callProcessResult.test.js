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
    // Never names Reprocess: a blocked row is still 'processing', and both
    // lists show Reprocess only once the row reads 'processed'.
    expect(v.text).not.toMatch(/Reprocess/);
  });

  it("the server's own explanation wins over the fallback copy", () => {
    // The retry window depends on whether the run was forced, and only the
    // server knows which constants apply — hardcoding "ten minutes" here cost
    // an operator seven of them on a hot call.
    const v = describeProcessResult({
      success: false,
      skipped: true,
      reason: "already_processing",
      error: "Another pass is still working this call. If it has stalled, try again about 3 minutes after it goes quiet.",
    });
    expect(v.severity).toBe("blocked");
    expect(v.text).toMatch(/about 3 minutes/);
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
    for (const reason of ["already_processed", "spam", "voicemail"]) {
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

  it("a rejected implausible transcript is settled, not pending", () => {
    // The server stamps a terminal rejection and cleans up prior artifacts;
    // amber here would falsely suggest a Reprocess is owed.
    const v = describeProcessResult({ success: true, skipped: true, reason: "transcription_rejected_implausible" });
    expect(v.didWork).toBe(true);
    expect(v.severity).toBe("ok");
  });

  it("a settled skip without confirmed success is not accepted either", () => {
    // Every settled reason processRecording returns carries success: true,
    // so this shape is a malformed response, not a classified call.
    for (const body of [
      { skipped: true, reason: "spam" },
      { success: false, skipped: true, reason: "spam" },
    ]) {
      const v = describeProcessResult(body);
      expect(v.didWork).toBe(false);
      expect(v.severity).not.toBe("ok");
    }
  });

  it("an ownership loss does not claim nothing was saved", () => {
    // The transcript is persisted before the terminal fence, so a pass that
    // loses its claim may already have written real work.
    const v = describeProcessResult({ success: true, skipped: true, reason: "terminal_write_ownership_lost" });
    expect(v.severity).toBe("blocked");
    expect(v.text).not.toMatch(/[Nn]othing was saved/);
    expect(v.text).toMatch(/took this call over/);
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

  it("anything that is not an explicit success fails closed", () => {
    // A malformed or regressed API response must never read as a completed
    // run — that is the false success this whole module exists to stop.
    for (const body of [null, undefined, {}, { extracted: { first_name: "PersonA" } }]) {
      const v = describeProcessResult(body);
      expect(v.didWork).toBe(false);
      expect(v.severity).toBe("failed");
    }
  });
});
