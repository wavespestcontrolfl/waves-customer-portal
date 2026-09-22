import { describe, expect, it } from "vitest";
import { needsSmsReply } from "./sms-delivery";

const message = (direction, createdAt, overrides = {}) => ({
  direction,
  createdAt,
  from: direction === "inbound" ? "+15555550100" : "+19413187612",
  to: direction === "inbound" ? "+19413187612" : "+15555550100",
  messageType: direction === "outbound" ? "manual" : "inbound",
  status: direction === "outbound" ? "sent" : "received",
  ...overrides,
});

describe("needsSmsReply", () => {
  it("returns false when there is no inbound message to answer", () => {
    expect(needsSmsReply([])).toBe(false);
    expect(needsSmsReply([
      message("outbound", "2026-09-21T13:00:00Z"),
    ])).toBe(false);
  });

  it.each([
    ["manual", "sent"],
    ["ai_approved", "delivered"],
    ["ai_revised", "sent"],
    ["ai_assistant", "delivered"],
    ["ai_assistant_reply", "sent"],
    ["follow_up", "queued"],
  ])("treats a subsequent %s message with status %s as an answer", (messageType, status) => {
    expect(needsSmsReply([
      message("inbound", "2026-09-21T13:00:00Z"),
      message("outbound", "2026-09-21T13:01:00Z", { messageType, status }),
    ])).toBe(false);
  });

  it.each([
    "failed",
    "undelivered",
    "suppressed",
    "cancelled",
    "canceled",
    "scheduled",
    "accepted",
  ])("does not treat a human reply with status %s as an answer", (status) => {
    expect(needsSmsReply([
      message("inbound", "2026-09-21T13:00:00Z"),
      message("outbound", "2026-09-21T13:01:00Z", { status }),
    ])).toBe(true);
  });

  it.each([
    "ai_draft",
    "auto_reply",
    "reminder",
    "confirmation",
    "review_request",
    "estimate",
    "post_service",
  ])("does not let a successful %s automation clear the inbound", (messageType) => {
    expect(needsSmsReply([
      message("inbound", "2026-09-21T13:00:00Z"),
      message("outbound", "2026-09-21T13:01:00Z", { messageType, status: "delivered" }),
    ])).toBe(true);
  });

  it("requires the human answer to come after the latest inbound regardless of input order", () => {
    const messages = [
      message("inbound", "2026-09-21T13:02:00Z"),
      message("outbound", "2026-09-21T13:01:00Z"),
      message("inbound", "2026-09-21T13:00:00Z"),
    ];

    expect(needsSmsReply(messages)).toBe(true);
    expect(needsSmsReply([
      message("outbound", "2026-09-21T13:03:00Z", { status: "delivered" }),
      ...messages,
    ])).toBe(false);
  });

  it("keeps business lines isolated when deciding whether an inbound was answered", () => {
    const inboundOnLineA = message("inbound", "2026-09-21T13:00:00Z", {
      to: "+19413187612",
    });
    const replyOnLineB = message("outbound", "2026-09-21T13:01:00Z", {
      from: "+19415550199",
      status: "delivered",
    });

    expect(needsSmsReply([inboundOnLineA, replyOnLineB])).toBe(true);
    expect(needsSmsReply([
      inboundOnLineA,
      replyOnLineB,
      message("outbound", "2026-09-21T13:02:00Z", {
        from: "(941) 318-7612",
        status: "delivered",
      }),
    ])).toBe(false);
  });

  it("needs a reply when any business line still has an unanswered inbound", () => {
    expect(needsSmsReply([
      message("inbound", "2026-09-21T13:00:00Z", { to: "+19413187612" }),
      message("outbound", "2026-09-21T13:01:00Z", { from: "+19413187612" }),
      message("inbound", "2026-09-21T13:02:00Z", { to: "+19415550199" }),
    ])).toBe(true);
  });

  it.each(["opt_in", "sms_reaction", "help_request", "reschedule_reply", "job_applicant_reply"])(
    "does not treat a standalone %s inbound as a customer request",
    (messageType) => {
      expect(needsSmsReply([
        message("inbound", "2026-09-21T13:00:00Z", { messageType }),
      ])).toBe(false);
    },
  );

  it("ignores a reaction after a customer request without hiding the earlier request", () => {
    expect(needsSmsReply([
      message("inbound", "2026-09-21T13:00:00Z"),
      message("inbound", "2026-09-21T13:01:00Z", { messageType: "sms_reaction" }),
    ])).toBe(true);
  });

  it("retires an older customer request after opt-out but surfaces a later new request", () => {
    const request = message("inbound", "2026-09-21T13:00:00Z");
    const optOut = message("inbound", "2026-09-21T13:01:00Z", { messageType: "opt_out" });

    expect(needsSmsReply([request, optOut])).toBe(false);
    expect(needsSmsReply([
      request,
      optOut,
      message("inbound", "2026-09-21T13:02:00Z"),
    ])).toBe(true);
  });
});
