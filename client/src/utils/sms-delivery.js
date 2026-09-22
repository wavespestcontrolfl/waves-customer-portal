// Suppressed sends can return sent:true with a sentinel instead of a SID.
// Clear a composer only after the SMS/MMS provider has accepted the message.
// Message SID contract: https://www.twilio.com/docs/messaging/api/message-resource
export function isAcceptedSms(result) {
  return Boolean(result?.sent && /^(SM|MM)[0-9a-f]{32}$/i.test(result.providerMessageId || ""));
}

const HUMAN_REPLY_TYPES = new Set([
  "manual",
  "ai_approved",
  "ai_revised",
  "ai_assistant",
  "ai_assistant_reply",
  "follow_up",
]);

// Keep this aligned with loadUnansweredThreads. `queued` means the provider
// accepted an immediate send; delayed inbox sends use the distinct `scheduled`
// status. A bare `accepted` is not enough delivery evidence in that watcher.
const ANSWERED_STATUSES = new Set(["queued", "sent", "delivered"]);

const NON_ACTIONABLE_INBOUND_TYPES = new Set([
  "opt_out",
  "opt_in",
  "sms_reaction",
  "help_request",
  "reschedule_reply",
]);

function phoneKey(phone) {
  const value = String(phone || "");
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (/^1\d{10}$/.test(digits)) return digits.slice(-10);
  if (/^\d{10}$/.test(digits) && !value.trim().startsWith("+")) return digits;
  return `+${digits}`;
}

function businessLineKey(message) {
  return phoneKey(message?.direction === "inbound" ? message.to : message.from);
}

function messageTime(message) {
  return new Date(message?.createdAt).getTime();
}

function isActionableInbound(message) {
  if (message?.direction !== "inbound") return false;
  const messageType = message.messageType || "";
  return !NON_ACTIONABLE_INBOUND_TYPES.has(messageType) && !messageType.startsWith("job_");
}

export function unansweredSmsReply(messages) {
  if (!Array.isArray(messages)) return null;

  const latestInboundByLine = new Map();
  let latestOptOutAt = -Infinity;

  messages.forEach((message) => {
    const createdAt = messageTime(message);
    if (Number.isNaN(createdAt)) return;
    if (message?.direction === "inbound" && message.messageType === "opt_out") {
      latestOptOutAt = Math.max(latestOptOutAt, createdAt);
    }
    if (!isActionableInbound(message)) return;
    const line = businessLineKey(message);
    if (createdAt > (latestInboundByLine.get(line)?.createdAt ?? -Infinity)) {
      latestInboundByLine.set(line, {
        createdAt,
        businessLine: message.to || null,
        message,
      });
    }
  });

  let latestUnanswered = null;
  latestInboundByLine.forEach(({ createdAt: latestInboundAt, businessLine, message: inbound }, line) => {
    // STOP applies to the contact, not one endpoint, and closes any older ask.
    if (latestOptOutAt > latestInboundAt) return;
    const answered = messages.some((message) => {
      if (message?.direction !== "outbound") return false;
      if (businessLineKey(message) !== line) return false;
      if (!HUMAN_REPLY_TYPES.has(message.messageType)) return false;
      if (!ANSWERED_STATUSES.has(message.status)) return false;
      const createdAt = messageTime(message);
      return !Number.isNaN(createdAt) && createdAt > latestInboundAt;
    });
    if (!answered && latestInboundAt > (latestUnanswered?.createdAt ?? -Infinity)) {
      latestUnanswered = {
        createdAt: latestInboundAt,
        businessLine,
        messageId: inbound.id,
        messageType: inbound.messageType,
      };
    }
  });

  if (!latestUnanswered?.businessLine) return null;
  const { businessLine, messageId, messageType } = latestUnanswered;
  return { businessLine, messageId, messageType };
}
