/**
 * Set texts: fixed-wording customer texts a technician sends from their own
 * line with one tap (GATE_TECH_SET_TEXTS, dark). The wording lives here, on
 * the server, so a button can never carry free text, and the same three texts
 * serve the Visit Brief buttons now and the hands-free voice line later.
 *
 *   - renderSetText    the body for one kind, greeting the customer by first name
 *   - setTextClaimKey  ONE duplicate check per visit and kind, shared by every
 *                      caller, so a button tap and a voice request for the same
 *                      text on the same visit send it once
 *   - openSetTextVisit a set text is for today's visit that has not ended
 *   - setTextReply     the customer's answer to the newest set text for a stop
 *                      (its visit ids), matched only when it cannot belong to
 *                      another visit
 *
 * The send itself is the tech-line text path (routes/tech-line.js): every
 * consent, suppression and duplicate guard applies. Each sent set text keeps
 * its visit and kind in the send's messaging_audit_log metadata, which is what
 * setTextReply reads; the reply is the inbound sms_log row on the tech's line.
 */
const { etDateString } = require('../utils/datetime-et');

const SET_TEXTS = Object.freeze({
  gate_locked: Object.freeze({
    label: 'Back gate locked',
    text: (hi) => `${hi}, your back gate is locked. If you can unlock it in the next few minutes, reply here and we'll treat the backyard before we leave.`,
  }),
  dog_outside: Object.freeze({
    label: 'Dog outside',
    text: (hi) => `${hi}, your dog is out in the yard. Could you bring them in for a few minutes so we can treat? Reply here when the yard is clear.`,
  }),
  garage_access: Object.freeze({
    label: 'Need garage access',
    text: (hi) => `${hi}, we need into the garage for today's treatment. Could you open it for us? Reply here when it's open.`,
  }),
});
const SET_TEXT_KINDS = Object.freeze(Object.keys(SET_TEXTS));

// Same ended list the tech code reader uses (access-code-capture.js): a visit
// in one of these states is over, so a "your gate is locked" text is stale.
const ENDED_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

// A reply is matched to a set text sent within this window; older set texts
// are about an earlier visit day.
const REPLY_WINDOW_MS = 12 * 60 * 60 * 1000;
const REPLY_PREVIEW_CHARS = 320;

function isSetTextKind(kind) {
  return Object.prototype.hasOwnProperty.call(SET_TEXTS, String(kind || ''));
}

function setTextLabel(kind) {
  return isSetTextKind(kind) ? SET_TEXTS[kind].label : null;
}

// "Hi Maria" for a usable first name, else "Hi there". Only the first word, so
// "Maria & Juan" reads "Hi Maria" rather than a long run-on greeting.
function greeting(customer) {
  const first = String(customer?.first_name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,24}$/.test(first) ? `Hi ${first}` : 'Hi there';
}

function renderSetText(kind, customer) {
  if (!isSetTextKind(kind)) throw new Error(`unknown set text kind: ${kind}`);
  return SET_TEXTS[kind].text(greeting(customer));
}

function setTextClaimKey(visitId, kind) {
  return `tech-set-text:${visitId}:${kind}`;
}

async function openSetTextVisit(conn, visitId, now = new Date()) {
  const row = await conn('scheduled_services')
    .where({ id: visitId })
    .where('scheduled_date', etDateString(now))
    .whereRaw(`COALESCE(status, 'pending') NOT IN (${ENDED_STATUSES.map(() => '?').join(', ')})`, ENDED_STATUSES)
    .first('id');
  return Boolean(row);
}

function metaOf(row) {
  const m = row?.metadata;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m) || {}; } catch { return {}; }
}

// A send that really left: an accepted provider id, never a suppression
// sentinel such as 'gate-blocked', which the audit row also carries with a
// sent_at (the same rule the send route reports through).
function deliveredSetText(row) {
  const { isRealProviderSend } = require('./sms-auto-send');
  return row.blocked_code == null && isRealProviderSend({ sent: true, providerMessageId: row.provider_message_id });
}

/**
 * The customer's newest answer to the newest set text for one stop.
 *
 * `visitIds` are the stop's visits (a grouped stop has several, and the one
 * the panel leads with can change as members finish), so a set text sent for
 * any of them is the stop's. Only the tech's own line counts: a delivered set
 * text from that line within the window, and an inbound text from the
 * customer's phone to that line after it. When the same line sent this
 * customer a set text for a visit OUTSIDE the stop in the window (two homes,
 * two visits), an answer cannot be tied to one stop, so it is reported as
 * ambiguous and shown on neither.
 *
 * @returns {Promise<{ setText: null|{kind,label,sentAt}, reply: null|{body,receivedAt,mediaCount}, ambiguous: boolean }>}
 */
async function setTextReply(conn, { customerId, customerPhone, lineNumber, visitIds, now = new Date() }) {
  const stopIds = new Set(visitIds);
  const since = new Date(now.getTime() - REPLY_WINDOW_MS);
  const sends = (await conn('messaging_audit_log')
    .where({ customer_id: customerId, entry_point: 'tech_line_text' })
    .whereNotNull('sent_at')
    .whereNotNull('provider_message_id')
    .where('sent_at', '>=', since)
    .whereRaw("metadata->>'set_text_kind' IS NOT NULL")
    .orderBy('sent_at', 'desc')
    .select('sent_at', 'metadata', 'provider_message_id', 'blocked_code'))
    .filter((row) => metaOf(row).fromNumber === lineNumber && deliveredSetText(row));
  const mine = sends.find((row) => stopIds.has(metaOf(row).scheduled_service_id));
  if (!mine) return { setText: null, reply: null, ambiguous: false };
  const kind = metaOf(mine).set_text_kind;
  const setText = { kind, label: setTextLabel(kind), sentAt: mine.sent_at };
  if (sends.some((row) => !stopIds.has(metaOf(row).scheduled_service_id))) {
    return { setText, reply: null, ambiguous: true };
  }
  // The shared reader guard: no unresolved send reservation (a synthetic
  // 'sending' placeholder) is ever presented as a message.
  const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
  const reply = await excludeUnresolvedSendReservations(conn('sms_log')
    .where({ direction: 'inbound', from_phone: customerPhone, to_phone: lineNumber })
    .where('created_at', '>', mine.sent_at))
    .orderBy('created_at', 'desc')
    .first('message_body', 'created_at', 'metadata');
  if (!reply) return { setText, reply: null, ambiguous: false };
  const media = metaOf(reply).media;
  return {
    setText,
    reply: {
      body: String(reply.message_body || '').slice(0, REPLY_PREVIEW_CHARS),
      receivedAt: reply.created_at,
      mediaCount: Array.isArray(media) ? media.length : 0,
    },
    ambiguous: false,
  };
}

function setTextOptions() {
  return SET_TEXT_KINDS.map((kind) => ({ kind, label: SET_TEXTS[kind].label }));
}

module.exports = {
  SET_TEXT_KINDS,
  isSetTextKind,
  setTextLabel,
  setTextOptions,
  renderSetText,
  setTextClaimKey,
  openSetTextVisit,
  setTextReply,
  _test: { greeting, REPLY_WINDOW_MS },
};
