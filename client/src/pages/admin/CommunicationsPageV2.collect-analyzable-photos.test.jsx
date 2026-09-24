// collectAnalyzablePhotos is the pure, module-level function SmsTab's
// analyzablePhotos useMemo calls (Codex round-4 P2 on PR #4725: reduce
// SmsTab's own complexity for real by moving the photo-collection
// branching out of its body into an independently-testable unit). Covered
// here directly, with no rendering — the vitest cases in
// CommunicationsPageV2.inbox.test.jsx already prove SmsTab wires it in
// correctly end to end.
import { describe, expect, it } from "vitest";
import { collectAnalyzablePhotos } from "./CommunicationsPageV2";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const media = (key, overrides = {}) => ({ key, url: `https://signed.example/${key}`, contentType: "image/jpeg", ...overrides });

describe("collectAnalyzablePhotos", () => {
  it("returns an empty list for non-array input", () => {
    expect(collectAnalyzablePhotos(null, ALLOWED)).toEqual([]);
    expect(collectAnalyzablePhotos(undefined, ALLOWED)).toEqual([]);
  });

  it("skips outbound messages and messages with no media", () => {
    const messages = [
      { id: "m1", direction: "outbound", media: [media("a")], createdAt: "2024-01-01T00:00:00Z" },
      { id: "m2", direction: "inbound", media: null, createdAt: "2024-01-01T00:01:00Z" },
      { id: "m3", direction: "inbound", createdAt: "2024-01-01T00:02:00Z" },
    ];
    expect(collectAnalyzablePhotos(messages, ALLOWED)).toEqual([]);
  });

  it("skips a media item missing url or key", () => {
    const messages = [
      { id: "m1", direction: "inbound", createdAt: "2024-01-01T00:00:00Z", media: [{ key: "a" }, { url: "https://x" }] },
    ];
    expect(collectAnalyzablePhotos(messages, ALLOWED)).toEqual([]);
  });

  it("filters out a non-image MIME type (video, audio, vcard)", () => {
    const messages = [{
      id: "m1", direction: "inbound", createdAt: "2024-01-01T00:00:00Z",
      media: [media("video", { contentType: "video/mp4" }), media("photo")],
    }];
    const result = collectAnalyzablePhotos(messages, ALLOWED);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("photo");
  });

  it("falls back to mimeType when contentType is absent, case-insensitively", () => {
    const messages = [{
      id: "m1", direction: "inbound", createdAt: "2024-01-01T00:00:00Z",
      media: [{ key: "a", url: "https://signed.example/a", contentType: undefined, mimeType: "IMAGE/PNG" }],
    }];
    expect(collectAnalyzablePhotos(messages, ALLOWED)).toHaveLength(1);
  });

  it("produces one entry per media item (a single MMS can carry several) and carries messageId/customerId through", () => {
    const messages = [{
      id: "m1", direction: "inbound", createdAt: "2024-01-01T00:00:00Z", customerId: "customer-a",
      media: [media("a"), media("b")],
    }];
    const result = collectAnalyzablePhotos(messages, ALLOWED);
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.messageId === "m1" && p.customerId === "customer-a")).toBe(true);
  });

  it("defaults customerId to null when the message has none", () => {
    const messages = [{ id: "m1", direction: "inbound", createdAt: "2024-01-01T00:00:00Z", media: [media("a")] }];
    expect(collectAnalyzablePhotos(messages, ALLOWED)[0].customerId).toBeNull();
  });

  it("sorts newest first regardless of input order", () => {
    const messages = [
      { id: "old", direction: "inbound", createdAt: "2024-01-01T00:00:00Z", media: [media("old-key")] },
      { id: "new", direction: "inbound", createdAt: "2024-01-02T00:00:00Z", media: [media("new-key")] },
    ];
    const result = collectAnalyzablePhotos(messages, ALLOWED);
    expect(result.map((p) => p.key)).toEqual(["new-key", "old-key"]);
  });
});
