/**
 * Several confirm cards in one Intelligence Bar answer (GATE_IB_MULTI_CARD,
 * owner request 2026-10-20).
 *
 * Today, on the platform path, the first confirm card of a request closes the
 * write frontier: every later write proposal gets `dependency_unresolved`, so
 * "update Smith's phone and move Jones to Friday" needs two requests. With the
 * gate on, a later write may mint its own card when it is INDEPENDENT of every
 * earlier unconfirmed card of the same request:
 *   - it is an open edit (the allowlist below). A refund, card charge, price,
 *     rate or tier change, setting, delete, merge, bulk change, outside-service
 *     action or record-creating action never joins a set. Such a card, when it
 *     is the first one, closes the frontier exactly as before;
 *   - it names its target record by id, and no id it names (customer, lead,
 *     visit, invoice, estimate, property) is one an earlier card names. A
 *     same-record proposal waits: the owner confirms the first card, then asks
 *     again;
 *   - no earlier card created a record, so nothing in it can come from an
 *     earlier card's result (the allowlist holds no creator), and it does not
 *     mention an earlier card's record id anywhere in its input.
 * At most MAX_CARDS cards per request.
 *
 * This module only decides admission. Each card is stored, pinned and
 * confirmed by the existing path, so every card keeps its own frozen
 * preconditions and confirming one never alters another. Address text in a
 * write stays a card (owner ruling 2026-10-12): that decision is not made here.
 */

const MAX_CARDS = 5;

const DEPENDENCY_MESSAGE = 'The preceding write needs a successful recorded outcome before another write can be prepared.';
const SAME_RECORD_MESSAGE = 'An earlier card in this request already changes the same record. Do not prepare this change now: tell the operator to confirm or cancel that card, then ask for this change again.';
const LIMIT_MESSAGE = `This request already has ${MAX_CARDS} confirmation cards, the most one answer can hold. Do not prepare this change now: tell the operator to confirm those cards, then ask for this change again.`;

// update_customer fields an extra card may carry: contact, address, source and
// notes. waveguard_tier, monthly_rate, pipeline_stage and active are money or
// lifecycle (a "price" or "setting" in the owner's words) and stay one-card.
const CUSTOMER_EDIT_FIELDS = new Set(['first_name', 'last_name', 'email', 'phone', 'city', 'state', 'zip',
  'address_line1', 'address_line2', 'lead_source', 'notes']);

const idOf = value => (value === undefined || value === null || value === '' || typeof value === 'object'
  ? null : String(value).trim().toLowerCase() || null);
const first = (input, ...names) => names.map(name => idOf(input[name])).find(Boolean) || null;
const tag = (kind, id) => (id ? `${kind}:${id}` : null);

// tool -> { keys(input): array of record keys, or null when the target is not
// named by id (a name, a phone) or the call is outside the set }.
const RULES = {
  update_lead_contact: input => [tag('lead', first(input, 'lead_id', 'leadId'))],
  update_lead_status: input => [tag('lead', first(input, 'lead_id', 'leadId'))],
  update_customer: (input) => {
    const updates = input.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return null;
    const fields = Object.keys(updates);
    if (!fields.length || fields.some(field => !CUSTOMER_EDIT_FIELDS.has(field))) return null;
    return [tag('customer', first(input, 'customer_id', 'customerId'))];
  },
  update_customer_property: input => [tag('customer', first(input, 'customer_id', 'customerId')), tag('property', first(input, 'property_id', 'propertyId'))],
  update_property_access: input => [tag('customer', first(input, 'customer_id', 'customerId'))],
  set_primary_property: input => [tag('customer', first(input, 'customer_id', 'customerId')), tag('property', first(input, 'property_id', 'propertyId'))],
  add_customer_property: input => [tag('customer', first(input, 'customer_id', 'customerId'))],
  assign_technician: (input) => {
    const ids = Array.isArray(input.service_ids) ? input.service_ids.map(idOf) : [];
    return ids.length && ids.every(Boolean) ? ids.map(id => tag('visit', id)) : null;
  },
  reschedule_appointment: input => [tag('visit', first(input, 'appointment_id', 'appointmentId'))],
  send_sms: input => [tag('customer', first(input, 'customer_id', 'customerId'))],
  reply_via_sms: input => [tag('customer', first(input, 'customer_id', 'customerId'))],
  // A stated price is a price decision; only the catalog price joins a set.
  create_appointment: input => (input.price === undefined || input.price === null || input.price === ''
    ? [tag('customer', first(input, 'customer_id', 'customerId'))] : null),
};

// The record keys a proposal names, or null when it is not eligible for a set.
function recordKeys(toolName, input) {
  const rule = Object.prototype.hasOwnProperty.call(RULES, toolName) ? RULES[toolName] : null;
  if (!rule) return null;
  const keys = rule(input && typeof input === 'object' ? input : {});
  if (!keys || !keys.length || keys.some(key => !key)) return null;
  return [...new Set(keys)];
}

// Does any string anywhere in the input contain one of these ids?
function mentionsAny(value, ids, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') { const text = value.toLowerCase(); return [...ids].some(id => text.includes(id)); }
  if (Array.isArray(value)) return value.some(item => mentionsAny(item, ids, depth + 1));
  if (typeof value === 'object') return Object.values(value).some(item => mentionsAny(item, ids, depth + 1));
  return false;
}

// What an open card remembers of its proposal: the tool and its record keys.
// null = the tool/call may not share a request with other cards, so the
// caller closes the frontier as today.
function record(toolName, input) {
  const keys = recordKeys(toolName, input);
  return keys ? { tool: toolName, keys } : null;
}

// Is this later write proposal admitted next to the request's open cards?
// null = admitted. Otherwise the refusal the model sees (nothing is stored).
function admit(toolUse, openCards) {
  const input = toolUse?.input || {};
  const keys = recordKeys(toolUse?.name, input);
  if (!keys) return { error: DEPENDENCY_MESSAGE, code: 'dependency_unresolved' };
  if (openCards.length >= MAX_CARDS) return { error: LIMIT_MESSAGE, code: 'card_limit_reached' };
  const earlier = new Set(openCards.flatMap(card => card.keys));
  if (keys.some(key => earlier.has(key))) return { error: SAME_RECORD_MESSAGE, code: 'same_record_card_open' };
  const earlierIds = new Set([...earlier].map(key => key.slice(key.indexOf(':') + 1)));
  if (mentionsAny(input, earlierIds)) return { error: DEPENDENCY_MESSAGE, code: 'dependency_unresolved' };
  return null;
}

// Added to the system prompt while the gate is on.
const PROMPT = `

SEVERAL CARDS IN ONE ANSWER:
- When the operator asks for changes to different records in one message (for example one edit for Smith and one for Jones), prepare one card for each change, one call per change, up to ${MAX_CARDS}. Each card is confirmed or cancelled on its own.
- Two changes to the same customer, lead or visit, or a change that needs the result of an earlier card, are not prepared together: prepare the first, tell the operator to confirm it, and prepare the next when they ask again.
- Refunds, card charges, prices, rates, settings, deletes and bulk changes always stay a single card.
- Say how many cards you prepared. Never say a change is done before its own card is confirmed.`;

module.exports = { MAX_CARDS, PROMPT, record, admit, recordKeys };
