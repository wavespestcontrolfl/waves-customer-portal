import { describe, expect, it } from "vitest";
import { unansweredSmsReply } from "./sms-delivery";

const needsSmsReply = (messages) => Boolean(unansweredSmsReply(messages));

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

  it("returns the business line with the latest unanswered inbound", () => {
    expect(unansweredSmsReply([
      message("inbound", "2026-09-21T13:00:00Z", { to: "+19413187612" }),
      message("inbound", "2026-09-21T13:02:00Z", { to: "+19415550199" }),
    ])?.businessLine).toBe("+19415550199");
  });

  it("keeps the reply routed to an older unanswered line after newer activity elsewhere", () => {
    expect(unansweredSmsReply([
      message("inbound", "2026-09-21T13:00:00Z", { to: "+19413187612" }),
      message("outbound", "2026-09-21T13:01:00Z", {
        from: "+19415550199",
        messageType: "reminder",
        status: "delivered",
      }),
    ])?.businessLine).toBe("+19413187612");
  });

  it("returns reply context from the outstanding inbound instead of newer excluded activity", () => {
    expect(unansweredSmsReply([
      message("inbound", "2026-09-21T13:00:00Z", {
        id: "customer-request",
        to: "+19413187612",
      }),
      message("inbound", "2026-09-21T13:01:00Z", {
        id: "applicant-reply",
        to: "+19415550199",
        messageType: "job_applicant_reply",
      }),
    ])).toEqual({
      businessLine: "+19413187612",
      messageId: "customer-request",
      messageType: "inbound",
    });
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

describe("conversation response state", () => {
  const request = message("inbound", "2026-09-21T13:00:00Z", { body: "Can you check the gate?", isRead: true });
  const closer = message("inbound", "2026-09-21T13:01:00Z", { body: "Thank you!", courtesyOnly: true });

  it("keeps a read question pending and retires it when a courtesy closer follows", () => {
    expect(needsSmsReply([request])).toBe(true);
    expect(needsSmsReply([closer, request])).toBe(false);
  });

  it("reopens for a new question after a closer", () => {
    expect(needsSmsReply([closer, request, message("inbound", "2026-09-21T13:02:00Z", { body: "Thanks, can you come tomorrow?", courtesyOnly: false })])).toBe(true);
  });

  it("does not let an acknowledgment on another business line retire a request", () => {
    expect(needsSmsReply([request, { ...closer, to: "+19415550199" }])).toBe(true);
  });

  it("keeps a photo actionable even if courtesy metadata is present", () => {
    expect(needsSmsReply([{ ...closer, media: [{ url: "https://example.invalid/photo.jpg" }] }])).toBe(true);
  });

  it("retires an enforced spam message but reopens for a later real request", () => {
    const spam = { ...closer, courtesyOnly: false, spamEnforced: true };
    expect(needsSmsReply([request, spam])).toBe(false);
    expect(needsSmsReply([spam, { ...request, createdAt: "2026-09-21T13:02:00Z" }])).toBe(true);
  });
});

it("uses authoritative legacy response types and delivery states without changing reply context", () => {
  const request = message("inbound", "2026-09-21T13:00:00Z", { id: "request" });
  const stop = message("inbound", "2026-09-21T13:01:00Z", { responseMessageType: "opt_out" });
  expect(needsSmsReply([request, stop])).toBe(false);
  const reply = message("outbound", "2026-09-21T13:01:00Z", { status: "queued", responseStatus: "failed" });
  expect(needsSmsReply([request, reply])).toBe(true);
  expect(needsSmsReply([request, { ...reply, responseStatus: "delivered" }])).toBe(false);
  expect(needsSmsReply([request, { ...reply, responseStatus: "delivered", responseMessageType: "reminder" }])).toBe(true);
});

it("does not treat a proactive approved draft as an answer but allows a nearby real reply", () => {
  const request = message("inbound", "2026-09-21T13:00:00Z");
  const nudge = message("outbound", "2026-09-21T13:01:00Z", { messageType: "ai_approved", responseIsAnswer: false });
  expect(needsSmsReply([request, nudge])).toBe(true);
  const reply = message("outbound", "2026-09-21T13:01:30Z", { responseIsAnswer: true });
  expect(needsSmsReply([request, nudge, reply])).toBe(false);
});
