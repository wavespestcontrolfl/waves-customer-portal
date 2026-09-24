const { isCourtesyOnly, outboundAsksForReply } = require('./sms-intent');

// Keep this list aligned with the unanswered-communications watcher. These
// are the outbound SMS types that represent a real answer to the customer;
// reminders, receipts, review asks, and other automated sends do not.
const HUMAN_REPLY_TYPES = Object.freeze([
  'manual',
  'ai_approved',
  'ai_revised',
  'ai_assistant',
  'ai_assistant_reply',
  'follow_up',
]);

const NON_ACTIONABLE_INBOUND_TYPES = Object.freeze([
  'opt_out',
  'opt_in',
  'sms_reaction',
  'help_request',
  'reschedule_reply',
]);

function phoneIdentitySql(column) {
  const digits = `REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN ${digits} = '' THEN ''
    WHEN ${digits} ~ '^1[0-9]{10}$' THEN RIGHT(${digits}, 10)
    WHEN ${digits} ~ '^[0-9]{10}$' AND COALESCE(${column}, '') NOT LIKE '+%' THEN ${digits}
    ELSE '+' || ${digits} END)`;
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mediaItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Narrow client-safe flags. Raw metadata remains server-only. Historical
// rows predate the webhook's courtesyOnly stamp, so classify their body with
// the same fail-safe detector. An attachment always keeps an inbound text
// actionable even when its caption is a courtesy phrase.
function responseFlags({
  direction,
  body,
  media,
  metadata,
  legacyMetadata,
  auditMetadata,
  priorOutboundBody,
} = {}) {
  const meta = { ...jsonObject(metadata), ...jsonObject(legacyMetadata), ...jsonObject(auditMetadata) };
  const directMedia = mediaItems(media);
  const attachments = directMedia.length ? directMedia : mediaItems(meta.media);
  const inbound = direction === 'inbound';
  const hasMedia = inbound && attachments.length > 0;
  const stampedCourtesy = typeof meta.courtesyOnly === 'boolean' ? meta.courtesyOnly : null;
  const courtesyOnly = inbound && !hasMedia && (
    stampedCourtesy === true
    || (stampedCourtesy == null
      && priorOutboundBody != null
      && isCourtesyOnly(body, { awaitingAnswer: outboundAsksForReply(priorOutboundBody) }))
  );
  const spamEnforced = inbound && !hasMedia && meta.spam_verdict?.enforced === true;
  return { courtesyOnly, spamEnforced, hasMedia };
}

function inboundNeedsResponse(message) {
  const flags = responseFlags(message);
  return flags.hasMedia || (!flags.courtesyOnly && !flags.spamEnforced);
}

function outboundIsAnswer({ direction, messageType, status, isClickFollowup = false } = {}) {
  return direction === 'outbound'
    && HUMAN_REPLY_TYPES.includes(messageType)
    && ['queued', 'sent', 'delivered'].includes(status)
    && !isClickFollowup;
}

module.exports = {
  HUMAN_REPLY_TYPES,
  NON_ACTIONABLE_INBOUND_TYPES,
  phoneIdentitySql,
  responseFlags,
  inboundNeedsResponse,
  outboundIsAnswer,
  _private: { jsonObject, mediaItems },
};
