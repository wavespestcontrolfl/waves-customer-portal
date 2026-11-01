'use strict';

/**
 * GATE_PORTAL_CHAT_OPEN: the portal chat assistant answers more and files
 * quote and moving requests itself (owner 2026-11-01, after a replay of 38
 * real chats). Everything here is reached only when that gate is live; with
 * it off the prompt, the tools and the keyword pre-check are the ones
 * assistant.js and tools.js already had, byte for byte.
 *
 *  - withOpen(): the gated prompt segments, applied on top of whichever other
 *    portal prompt gates are live.
 *  - request_quote / request_move tool definitions and the quote writer.
 *  - the `say` sentence a hand-off may add, and the text helpers the single
 *    per-chat hand-off item uses.
 *
 * Nothing in this file texts, emails or calls a customer, and it makes no
 * paid call.
 */

const logger = require('../logger');

// A turn deadline or an aborted query is never swallowed by a tool.
const CANCELLATION_CODES = new Set(['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014']);
const CANCELLATION_NAMES = new Set(['AbortError', 'KnexTimeoutError']);
const isCancellation = (err) => CANCELLATION_CODES.has(err?.code) || CANCELLATION_NAMES.has(err?.name);

// The only words that still force a hand-off before the model sees the
// message. Everything else (cancel, refund, owner, adam, ...) reaches the
// model, which decides under WHAT YOU MUST ESCALATE.
const PORTAL_OPEN_TRIGGERS = ['lawsuit', 'attorney', 'lawyer', 'bbb'];

const OPEN_CAN_DO = '- Ask the team for a written quote for a service (request_quote)\n- Send a moving customer\'s new address to the team (request_move)\n';

const CHARGES_ESCALATE_SENTENCE = 'or asks for a refund, use the escalate tool.';
const CHARGES_OPEN_SENTENCE = ' If show_recent_payments shows no payments and the customer asks you to explain a specific charge or bill, or says one is wrong, use the escalate tool with topic billing. A general question, such as why nothing is owed yet, is answered from COMPANY FACTS.';

const INSIDE_SERVICE_BEFORE = 'On a residential general pest plan that includes inside service (not mosquito service), the first visit';
const INSIDE_SERVICE_AFTER = 'Only on a residential general pest plan that includes inside service (not mosquito service): the first visit';
const HONEYBEE_LINE = '- We treat honeybees.';
const STATE_CONDITION_LINE = '- State every fact with its condition: never tell a customer they get inside service unless their plan includes it.\n';
const PRODUCT_LABELS_LINE = '- Product labels:';
const NEW_FACT_LINES = `- WaveGuard levels depend on how many qualifying recurring services the customer has: Bronze 1, Silver 2, Gold 3, Platinum 4 or more. Qualifying services: pest control, lawn care, tree and shrub care, mosquito control, termite bait monitoring. The level discount for each is shown on the customer's estimate and My Plan page; never state a percentage or price. For what the customer's own plan includes, open My Plan.
- Soil testing: we do not soil-test every lawn. The technician takes one soil sample only when a lawn needs it: new sod or a new-build lawn that is not thriving 60 days after install; yellowing that stays after an iron test, or a lawn no better after 2 visits with no pest or disease found (October to May); a bahia or pasture-origin lawn; or when phosphorus is planned in Manatee County. The sample goes to the University of Florida soil testing lab, which reports pH among other results, and we adjust the program from the results. One sample per lawn. Never promise a soil test on request or a copy of the lab report.
- Emails: if a customer wants Waves emails again after unsubscribing, the team turns them back on. Use the escalate tool with topic account_change and say the team will turn them back on.
`;

const PRICE_RULE_ANCHOR = '- Do not quote account-specific pricing\n';
const PRICE_RULE = '- Never state a price, a percentage or a discount, even if a tool result or an article gives one; prices are on the estimate and the My Plan page.\n';
const PESTS_SENTENCE_ANCHOR = 'or reports damage, escalate instead. ';
const PESTS_OPEN_SENTENCE = 'If you have shown the re-service button twice in this chat and the customer still writes about the pests, says they are scared or cannot sleep, or asks for a person, call escalate (the button stays). ';

const ESCALATE_HEADER = 'WHAT YOU MUST ESCALATE (use the escalate tool):';
const OPEN_SECTIONS = `CANCEL OR PAUSE:
If the customer names one visit to cancel (today, tomorrow, or a date), or says to cancel today's service, call escalate at once with topic schedule_change. Do not ask the reason, and do not offer Reschedule for a visit within 48 hours.
If the customer wants to cancel or pause their plan or one service because of chemicals, health or damage, escalate. Otherwise ask in one short sentence what is behind it, unless they already said. If pests are back, follow PESTS BACK BETWEEN VISITS. If they are moving, follow MOVING. For anything else, call get_upcoming_services first: if it returns no visits, escalate. If it returns visits, call open_portal_section with section plan and tell them that Account Options on the My Plan page walks them through it before anything changes: they can cancel the whole plan (or one service, when they have more than one), and if they will be away it offers Away Mode, which keeps the outside of the house treated for pest, or a hold of up to six months for lawn and mosquito with no charge for the skipped visits. Never offer a discount or any option the page does not show.

ADDING A SERVICE:
When the customer asks to add a service, asks what a service they do not have includes or costs, wants an estimate, or wants to sign up, say in a sentence or two what the program includes (from COMPANY FACTS), and call request_quote in the same turn. If they did not name the service, call request_quote with service not_stated and their words as the note, and ask which service in the same reply. Never state a price: the written estimate shows it.

MOVING:
When the customer is moving or wants to transfer service to a new home, call request_move in that same turn with what you have (the address and date may be empty), and ask in your reply for any part they have not given. If they give it later, call request_move again with it.

`;
const OPEN_ESCALATE_LIST = `${ESCALATE_HEADER}
- Complaints about service quality or technician behavior, or damage
- A cancellation or pause for a chemical, health or damage reason
- A billing dispute: the customer says a charge is wrong or asks for a refund
- A worry about chemicals or health: a person or pet exposed, a reaction, or a medical question about a product
- A legal threat
- A request to talk to a person
- Changes to account details the team makes: phone, address on file, gate code, pets
- A visit that cannot be moved online, one visit the customer still wants cancelled, or anything a tool tells you to escalate
- Anything you still cannot answer after using your tools
`;

// Insert `text` before the first `anchor` in `prompt`; when the anchor is not
// there (a prompt built without that other gate), the prompt is unchanged.
function insertBefore(prompt, anchor, text) {
  const at = prompt.indexOf(anchor);
  return at === -1 ? prompt : `${prompt.slice(0, at)}${text}${prompt.slice(at)}`;
}

// The company facts the open prompt adds. With the past-visit gate on they
// join the owner-approved block; without it they stand as a short block of
// their own, so the answers the gate promises are never left out.
function withOpenFacts(prompt) {
  const stated = insertBefore(prompt.replace(INSIDE_SERVICE_BEFORE, INSIDE_SERVICE_AFTER), HONEYBEE_LINE, STATE_CONDITION_LINE);
  if (stated.includes(PRODUCT_LABELS_LINE)) return insertBefore(stated, PRODUCT_LABELS_LINE, NEW_FACT_LINES);
  return insertBefore(stated, ESCALATE_HEADER, `COMPANY FACTS (owner-approved; state these plainly):\n${NEW_FACT_LINES}\n`);
}

// The escalate list, from its header up to the blank line before RULES.
function withOpenEscalateList(prompt) {
  const from = prompt.indexOf(ESCALATE_HEADER);
  if (from === -1) return prompt;
  const rules = prompt.indexOf('\nRULES:', from);
  const to = rules === -1 ? prompt.length : rules;
  return `${prompt.slice(0, from)}${OPEN_ESCALATE_LIST}${prompt.slice(to)}`;
}

// GATE_PORTAL_CHAT_OPEN on top of any portal prompt.
function withOpen(prompt) {
  const sections = insertBefore(
    insertBefore(prompt, '- Hand the conversation to the Waves team (escalate)', OPEN_CAN_DO)
      .replace(CHARGES_ESCALATE_SENTENCE, (kept) => `${kept}${CHARGES_OPEN_SENTENCE}`)
      .replace(PESTS_SENTENCE_ANCHOR, (kept) => `${kept}${PESTS_OPEN_SENTENCE}`)
      .replace(PRICE_RULE_ANCHOR, (kept) => `${kept}${PRICE_RULE}`),
    ESCALATE_HEADER,
    OPEN_SECTIONS,
  );
  return withOpenEscalateList(withOpenFacts(sections));
}

// ── tools ───────────────────────────────────────────────────────────────

const QUOTE_SERVICES = ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite', 'other', 'not_stated'];
const REQUEST_QUOTE_TOOL = {
  name: 'request_quote',
  description: 'Ask the team for a written quote (estimate) for a service the customer wants to add or price. Writes one quote request for the office. Use after you say what the program includes. Never state a price yourself.',
  input_schema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: QUOTE_SERVICES },
      note: { type: 'string', description: 'What the customer asked for, in their words' },
    },
    required: ['service', 'note'],
  },
};
const REQUEST_MOVE_TOOL = {
  name: 'request_move',
  description: 'Send a moving customer\'s new address (and move date if known) to the team as one item, so they can check the new home is served, price it and set up the last visit here and the first visit there.',
  input_schema: {
    type: 'object',
    properties: {
      new_address: { type: 'string', description: 'Empty if not given yet' },
      move_date: { type: 'string', description: 'As the customer said it, or empty' },
    },
    required: [],
  },
};
const SAY_PROPERTY = {
  type: 'string',
  description: 'Optional. One short sentence the fixed hand-off reply adds, saying what the team will do (for example: The team will turn our emails back on for you). No times, prices or promises beyond that.',
};
// The escalate tool with the optional `say` field (this gate only).
function escalateToolWithSay(tool) {
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: { ...tool.input_schema.properties, say: SAY_PROPERTY },
    },
  };
}

// ── the `say` sentence ──────────────────────────────────────────────────

const SAY_MAX_CHARS = 140;
// A link, an address of any kind, or a digit (a price, a time, a date) means
// the sentence is not used: the fixed reply says it without.
const SAY_REFUSED = /https?:|www\.|\.[a-z]{2,}\/|@|\d|\$/i;
// The first sentence of the model's text, at most SAY_MAX_CHARS characters,
// ending in a period; '' when the text is not usable. A second sentence is
// dropped, never squeezed in.
function sanitizeSay(raw) {
  const flat = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat || SAY_REFUSED.test(flat)) return '';
  const first = (flat.match(/^.+?[.!?](?=\s|$)/)?.[0] || flat).replace(/[.!?]+$/, '');
  if (!first || first.length + 1 > SAY_MAX_CHARS) return '';
  return `${first}.`;
}

// ── the single hand-off item per chat ───────────────────────────────────

const MOVE_MARKER = 'Customer is moving and asked the portal assistant to transfer service';
const MOVE_LINE = /^(New address|Move date):/;
const ALSO_LINE = 'Also in this chat:';
const flatLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The move a request_move call carries: one line each, capped.
function moveDetails(input = {}) {
  return { newAddress: flatLine(input.new_address, 200), moveDate: flatLine(input.move_date, 80) };
}

const NOT_GIVEN = 'not given yet';

// The address or date an earlier call saved on the summary ('' when none).
function savedMoveValue(lines, label) {
  const line = lines.find((l) => l.startsWith(`${label}: `));
  const value = line ? line.slice(label.length + 2).trim() : '';
  return value === NOT_GIVEN ? '' : value;
}

// The saved summary with this move on it. A second call replaces the first
// call's address and date lines (it never adds a second pair), and a field
// the second call leaves empty keeps the value the first call saved.
// The address and date a saved item holds, from its summary lines.
function savedMove(summary) {
  const lines = String(summary || '').split('\n');
  return { newAddress: savedMoveValue(lines, 'New address'), moveDate: savedMoveValue(lines, 'Move date') };
}

// The standing-item lookup skips confirmed email-change rows (their summary
// carries the email lines): those keep their own row and bell.
function withoutEmailRows(query) {
  return query
    .whereRaw("COALESCE(summary, '') NOT LIKE ?", ['%Email on file:%'])
    .whereRaw("COALESCE(summary, '') NOT LIKE ?", ['%asked to change their email%']);
}

function summaryWithMove(summary, move) {
  const all = String(summary || '').split('\n').filter(Boolean);
  const newAddress = move.newAddress || savedMoveValue(all, 'New address');
  const moveDate = move.moveDate || savedMoveValue(all, 'Move date');
  const lines = all.filter((line) => !MOVE_LINE.test(line));
  if (!lines.some((line) => line.includes(MOVE_MARKER))) {
    lines.push(lines.length ? `${ALSO_LINE} ${MOVE_MARKER}` : MOVE_MARKER);
  }
  lines.push(`New address: ${newAddress || NOT_GIVEN}`);
  lines.push(`Move date: ${moveDate || NOT_GIVEN}`);
  return lines.join('\n');
}

// The saved summary after a further hand-off in the same chat. A reason the
// row already holds is not added again (a replayed turn changes nothing).
function summaryWithReason(summary, reason) {
  const text = flatLine(reason, 600);
  const base = String(summary || '');
  if (!text || base.includes(text)) return base;
  return base ? `${base}\n${ALSO_LINE} ${text}` : text;
}

// The customer's words on the item: every distinct message of the chat that
// reached the team, oldest first.
function messageWithMore(saved, next) {
  const base = String(saved || '');
  const more = String(next || '').trim();
  if (!more || base.includes(more)) return base;
  return base ? `${base}\n\n${more}` : more;
}

// The standing item for a chat, merged with what this call carries. Returns
// the columns to write, or null when nothing changes.
function mergedItem(standing, { customerMessage, reason, move, urgent }) {
  const summary = move ? summaryWithMove(standing.summary, move) : summaryWithReason(standing.summary, reason);
  const message = messageWithMore(standing.customer_message, customerMessage);
  const priority = urgent && standing.priority !== 'urgent' ? 'urgent' : standing.priority;
  if (summary === standing.summary && message === standing.customer_message && priority === standing.priority) return null;
  return { summary, customer_message: message, priority, updated_at: new Date() };
}

// What the office reads under the bell: the item's summary lines, then the
// customer's words in full.
function itemBellDetail(item) {
  const message = String(item.customer_message || '');
  const summary = String(item.summary || '').trim();
  return summary ? `${summary}\n\nCustomer's message: ${message}` : message;
}

// ── the quote request ───────────────────────────────────────────────────

const QUOTE_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite: 'Termite Bait Stations',
  other: 'Another service',
  not_stated: 'Service not stated',
};
const QUOTE_NOTE_MAX = 500;
const QUOTE_INSTRUCTION = 'A quote request is now with the team. Tell the customer the team will reply by text or email, usually within one business hour between 8 AM and 8 PM, with a written estimate, and that nothing is booked or charged until they accept it. Do not state a price.';
const QUOTE_NOT_STATED_INSTRUCTION = ' Ask which service they want; when they say, call request_quote again with it.';

// The key service_requests.requested_service is saved under. A named service
// uses the key the estimate flows use (termite is the bait-station key); an
// unnamed one is saved as the word itself.
function quoteServiceKey(service, normalizeRequestedServiceKey) {
  if (service === 'other' || service === 'not_stated') return service;
  return normalizeRequestedServiceKey(service) || 'other';
}

async function ringQuoteBell({ customerId, label, outcome, requestId, turn }) {
  if (outcome.deduped) return;
  try {
    const db = require('../../models/db');
    const query = db('customers').where({ id: customerId }).first('first_name', 'last_name');
    const customer = await (turn ? turn.query(query, 'quote request customer') : query);
    const { triggerNotification } = require('../notification-triggers');
    await triggerNotification('bundle_quote_requested', {
      bundled: false,
      customerId,
      customerName: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || null,
      suggestedService: `${label} (quote requested in portal chat)`,
      relationship: 'add',
      refreshed: !!outcome.refreshed,
      requestId,
    });
  } catch (err) {
    if (isCancellation(err)) throw err;
    logger.warn(`[portal-chat-open] quote bell failed (request ${requestId} stands): ${err.message}`);
  }
}

// request_quote: one open add-service request per (customer, service), and
// one bell for it. The writer is the same one the portal home card and the
// service report use, so a second ask refreshes the standing row.
async function requestQuote(customerId, input, { open = false } = {}, turn = null) {
  if (open !== true) return { error: 'Unknown tool: request_quote' };
  const db = require('../../models/db');
  const { writeOrRefreshCtaRequest } = require('../cta-service-request');
  const { normalizeRequestedServiceKey } = require('../estimate-add-service-request');
  const service = QUOTE_SERVICES.includes(input.service) ? input.service : 'not_stated';
  const label = QUOTE_LABELS[service];
  const note = flatLine(input.note, QUOTE_NOTE_MAX);
  const requestedService = quoteServiceKey(service, normalizeRequestedServiceKey);
  const writer = turn ? { transaction: (work) => turn.transaction('quote request', work) } : db;
  const outcome = await writeOrRefreshCtaRequest(writer, {
    customerId,
    requestedService,
    source: 'portal_chat',
    subject: `Quote requested in portal chat: ${label}`,
    description: `Customer asked the portal chat assistant for a written quote (${label}). ${note ? `Their words: ${note}. ` : ''}Review and follow up. No customer message has been sent.`,
    revisionSnapshot: { source: 'portal_chat', service },
  });
  await ringQuoteBell({ customerId, label, outcome, requestId: outcome.request?.id, turn });
  return {
    sent: true,
    service,
    instruction: `${QUOTE_INSTRUCTION}${service === 'not_stated' ? QUOTE_NOT_STATED_INSTRUCTION : ''}`,
  };
}

// ── the moving request ──────────────────────────────────────────────────

const MOVE_INSTRUCTION = 'The move is now with the team. Tell the customer the team will check that the new home is in the service area, price it, and confirm by text or email, usually within one business hour between 8 AM and 8 PM. Do not promise a price, a date, or that the new address is served. If the address or date is missing, ask for it.';
const MOVE_FAILED_INSTRUCTION = 'The move could not be saved. Call escalate with topic account_change and put the new address and move date in the reason.';

// request_move: the hand-off item itself is written by assistant.js
// (context.recordMove), the one place that owns the chat's hand-off row and
// bell.
async function requestMove(input, { open = false, recordMove = null } = {}) {
  if (open !== true || typeof recordMove !== 'function') return { error: 'Unknown tool: request_move' };
  const move = moveDetails(input);
  let saved;
  try {
    saved = await recordMove(move);
  } catch (err) {
    if (isCancellation(err)) throw err;
    logger.error(`[portal-chat-open] move item failed: ${err.message}`);
    return { sent: false, instruction: MOVE_FAILED_INSTRUCTION };
  }
  // What is missing is judged from the saved item (it may already hold what
  // an earlier call gave), not from this call's input alone.
  const held = saved || move;
  return {
    sent: true,
    missing: [...(held.newAddress ? [] : ['new_address']), ...(held.moveDate ? [] : ['move_date'])],
    instruction: MOVE_INSTRUCTION,
  };
}

module.exports = {
  PORTAL_OPEN_TRIGGERS,
  isCancellation,
  REQUEST_QUOTE_TOOL,
  REQUEST_MOVE_TOOL,
  withOpen,
  escalateToolWithSay,
  sanitizeSay,
  moveDetails,
  mergedItem,
  summaryWithMove,
  savedMove,
  withoutEmailRows,
  itemBellDetail,
  requestQuote,
  requestMove,
};
