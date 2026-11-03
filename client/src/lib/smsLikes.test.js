import { describe, expect, it } from "vitest";
import { collapseCustomerReactions, likeableMessageId } from "./smsLikes";

// GATE_SMS_LIKE (owner 2026-11-02, "SMS Like Button").
const THUMB = "\u{1F44D}";
const CUSTOMER = "+19415550100";
const LINE = "+19413187612";
const at = (minute) => `2026-11-02T16:${String(minute).padStart(2, "0")}:00Z`;
// Messages rows: from / to, as GET /communications/log returns them.
const text = (id, direction, body, minute, extra = {}) => ({
  id, direction, body, createdAt: at(minute),
  from: direction === "inbound" ? CUSTOMER : LINE,
  to: direction === "inbound" ? LINE : CUSTOMER,
  ...extra,
});
const like = (id, target, minute, removed = false) => text(id, "inbound", `${removed ? "Removed a like from" : "Liked"} "${target}"`, minute, {
  likeable: false, customerReaction: { emoji: THUMB, removed, target },
});

describe("likeableMessageId", () => {
  const customer = (extra = {}) => text("in", "inbound", "Thanks!", 15, { likeable: true, officeLike: null, ...extra });

  it("offers the customer's newest text, and only while it has no like", () => {
    expect(likeableMessageId([text("out", "outbound", "See you Tuesday", 2), customer()])).toBe("in");
    expect(likeableMessageId([customer({ officeLike: { status: "sent" } })])).toBeNull();
    expect(likeableMessageId([customer({ likeable: false })])).toBeNull();
    expect(likeableMessageId([])).toBeNull();
  });

  it("offers nothing when a text of ours or another customer text came after it", () => {
    expect(likeableMessageId([customer(), text("out", "outbound", "Anything else?", 20)])).toBeNull();
    expect(likeableMessageId([customer(), like("r", "See you Tuesday", 21)])).toBeNull();
  });

  it("ignores calls in a mixed thread", () => {
    expect(likeableMessageId([customer(), text("call", "inbound", "Voicemail", 30, { channel: "voice" })])).toBe("in");
  });
});

describe("collapseCustomerReactions", () => {
  it("turns a like into a badge on our text it quotes exactly, and drops its bubble", () => {
    const ours = text("out", "outbound", "See you Tuesday", 2);
    const { visible, badges } = collapseCustomerReactions([ours, like("r1", "See you Tuesday", 3)]);
    expect(visible.map((m) => m.id)).toEqual(["out"]);
    expect(badges.get("out")).toEqual([{ id: "r1", emoji: THUMB, createdAt: at(3) }]);
  });

  it("keeps a like as a bubble when no earlier text of ours matches", () => {
    const { visible, badges } = collapseCustomerReactions([
      like("early", "See you Tuesday", 1),
      text("out", "outbound", "See you Tuesday", 2),
      like("other", "Something we never sent", 3),
      text("voice", "outbound", "Call summary", 4, { channel: "voice" }),
      like("call", "Call summary", 5),
    ]);
    expect(visible.map((m) => m.id)).toEqual(["early", "out", "other", "voice", "call"]);
    expect(badges.size).toBe(0);
  });

  it("keeps a loud like (the server sent no customerReaction) as a normal bubble", () => {
    const loud = text("loud", "inbound", 'Liked "See you Tuesday"', 3, { likeable: false, customerReaction: null });
    const { visible, badges } = collapseCustomerReactions([text("out", "outbound", "See you Tuesday", 2), loud]);
    expect(visible.map((m) => m.id)).toEqual(["out", "loud"]);
    expect(badges.size).toBe(0);
  });

  it("attaches to the newest earlier copy of a repeated text", () => {
    const { badges } = collapseCustomerReactions([
      text("old", "outbound", "On the way", 1),
      text("new", "outbound", "On the way", 5),
      like("r", "On the way", 6),
    ]);
    expect(badges.has("old")).toBe(false);
    expect(badges.get("new")).toHaveLength(1);
  });

  it("matches only our text between the same customer number and the same line", () => {
    const { visible, badges } = collapseCustomerReactions([
      text("line-a", "outbound", "On the way", 1),
      text("line-b", "outbound", "On the way", 2, { from: "+19415550000" }),
      like("r", "On the way", 3),
    ]);
    expect(badges.has("line-b")).toBe(false);
    expect(badges.get("line-a")).toHaveLength(1);
    expect(visible.map((m) => m.id)).toEqual(["line-a", "line-b"]);
  });

  it("reads Customer 360 rows by contactPhone and ourEndpointId; a like with an unknown number stays a bubble", () => {
    const row = (id, direction, body, minute, extra = {}) => ({
      id, direction, body, channel: "sms", createdAt: at(minute), contactPhone: "9415550100", ourEndpointId: LINE, ...extra,
    });
    const { badges } = collapseCustomerReactions([
      row("out", "outbound", "See you Tuesday", 2),
      row("r", "inbound", 'Liked "See you Tuesday"', 3, { customerReaction: { emoji: THUMB, removed: false, target: "See you Tuesday" } }),
    ]);
    expect(badges.get("out")).toHaveLength(1);

    const unknown = collapseCustomerReactions([text("out", "outbound", "See you Tuesday", 2), { ...like("r", "See you Tuesday", 3), from: null }]);
    expect(unknown.visible.map((m) => m.id)).toEqual(["out", "r"]);
  });

  it("a removal takes back the badge; a removal with nothing to take back stays a bubble", () => {
    const { visible, badges } = collapseCustomerReactions([
      text("out", "outbound", "See you Tuesday", 2),
      like("r1", "See you Tuesday", 3),
      like("r2", "See you Tuesday", 4, true),
      like("r3", "See you Tuesday", 5, true),
    ]);
    expect(visible.map((m) => m.id)).toEqual(["out", "r3"]);
    expect(badges.get("out")).toEqual([]);
  });
});
