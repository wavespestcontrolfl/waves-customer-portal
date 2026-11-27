/**
 * Intelligence Bar — add, change or remove a customer's extra contacts
 * server/services/intelligence-bar/service-contact-tools.js
 *
 * IB gap #28 (2026-11-27, "add secondary contact or authorized family member to customer account"): a card that
 * replays the customer page's own contact editor.
 *
 *   set_customer_service_contact — one of the three "service contact" slots on a customer (a spouse, a family member,
 *                                  a tenant, a property manager on site): add a person, change one, or remove one.
 *                                  Runs admin-customers.js setServiceContactsFromBar: the same PUT /admin/customers/:id
 *                                  handler, in process, with the three slots' name, phone and email exactly as the
 *                                  page's editor posts them. So the field checks, the phone and email formatting, the
 *                                  slot compaction, the role-follows-the-person rule and the consent-stamp clear are
 *                                  the route's own (normalizeChangedServiceContacts / compactServiceContactSlots, run
 *                                  here on the same inputs for the card).
 *
 * The card also records who the person is to the account (relationship: spouse_partner, tenant, ...; the call
 * pipeline's own list), stored as the slot's role through the handler's req.ibServiceContactRoles, because the report
 * sender reads it: a tenant never gets service reports. The page's editor cannot set it.
 *
 * What a contact gets, shown on the card: a contact's EMAIL gets this account's visit emails from the next one (the
 * email fan-out reads the slots with no consent step, appointment-email.js); a contact's TEXTS need the account's
 * contact consent stamp (customer-contact.js serviceContactsConsented), and a save that changes who is on the list
 * clears that stamp, so no contact is texted until they agree again in the app. Nothing is sent by this card.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only.
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins the customer, the slots as they are, the
 *                  consent stamp and the slots the save will write.
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler, which
 *                  re-checks the card on the LOCKED customer row (lockedPlanCheck) before it writes.
 *
 * Linking two customer profiles as one family (the 10% Multi-Home Discount "Same family" link) is not this tool: it
 * stays on the customer page.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

const ACTIONS = ['add', 'change', 'remove'];
// The person's relationship to the service, the call pipeline's own list (intake-normalize.js
// SECONDARY_CONTACT_ROLES) minus 'unknown'. It is stored as the slot's role, which the report sender reads: a tenant
// never gets service reports (customer-contact.js slotWithheldFromReports).
const RELATIONSHIPS = [...require('../../utils/intake-normalize').SECONDARY_CONTACT_ROLES].filter((r) => r !== 'unknown');
const relationshipLabel = (role) => String(role || '').replace(/_/g, ' ');
// The page editor's body keys per slot, in slot order (admin-customers.js customerUpdateHandler `fields`).
const BODY_KEYS = [
  ['serviceContactName', 'serviceContactPhone', 'serviceContactEmail'],
  ['serviceContact2Name', 'serviceContact2Phone', 'serviceContact2Email'],
  ['serviceContact3Name', 'serviceContact3Phone', 'serviceContact3Email'],
];

const SERVICE_CONTACT_TOOLS = [
  {
    name: 'set_customer_service_contact',
    description: `Add, change or remove ONE extra contact on a customer account: the customer page's "Service contacts" (up to three people besides the account holder, such as a spouse, a family member allowed to speak for the account, a tenant, or an on-site manager). The first call returns a PREVIEW and saves nothing; the operator approves it, and the approved run re-checks it and refuses if anything changed.
action "add": name, relationship, and a phone or an email (both when known); goes in the first empty slot. action "change": slot (1-3) plus what changes. action "remove": slot (1-3). Without a slot, the reply lists the numbered contacts on file.
Effects: a contact with an email can get this account's appointment emails, and service reports unless they are a tenant, as the account's notification settings allow. Texts to contacts need their consent in the app; a change to who is listed clears it. Removing a contact or changing their phone ends their app sign-in. Nothing is sent now. Admin only.
Not this tool: linking two customer profiles as one family for the multi-home discount (customer page "Same family"), a payer who receives the invoices (set_customer_bill_to), or the account holder's own name, phone or email.
Use for: "add his wife as a contact", "add <name> as an authorized family member", "put the tenant on the account", "add a second contact", "change the contact's phone", "remove <name> from the account".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer (from query_customers or get_customer_detail)' },
        action: { type: 'string', enum: ACTIONS, description: 'add a person, change one, or remove one' },
        slot: { type: 'integer', minimum: 1, maximum: 3, description: 'For change and remove: which contact (1, 2 or 3)' },
        name: { type: 'string', description: 'The contact\'s name, e.g. "Maria Lopez" (required to add)' },
        phone: { type: 'string', description: 'The contact\'s phone number' },
        email: { type: 'string', description: 'The contact\'s email address' },
        relationship: { type: 'string', enum: RELATIONSHIPS, description: 'Who the person is to the account (required to add; ask if unclear), e.g. spouse_partner, family_member, tenant' },
      },
      required: ['customer_id', 'action'],
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const text = (value) => (value == null ? '' : String(value).trim());
const phoneKey = (value) => text(value).replace(/\D/g, '').slice(-10);
const customerName = (c) => [c.first_name, c.last_name].map(text).filter(Boolean).join(' ') || text(c.company_name);

function routePrivate() {
  return require('../../routes/admin-customers')._private;
}

// The slots as stored: name, phone, email and the person's role, per slot.
function storedSlots(customer) {
  return routePrivate().SERVICE_CONTACT_SLOT_FIELDS.map(([n, p, e, r]) => ({
    name: text(customer[n]), phone: text(customer[p]), email: text(customer[e]), role: text(customer[r]) || null,
  }));
}
const isFilled = (slot) => !!(slot.name || slot.phone || slot.email);

function describe(slot) {
  const parts = [slot.role ? relationshipLabel(slot.role) : null, slot.phone || null, slot.email || null].filter(Boolean);
  return `${slot.name || 'No name'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// The numbered contacts on file, for a reply that needs the operator (or the model) to pick a slot.
const contactList = (slots) => slots.map((s, i) => (isFilled(s) ? { slot: i + 1, contact: describe(s) } : null)).filter(Boolean);

// The raw three-slot list the save sends: the stored slots with this one change applied.
function requestedSlots(slots, input) {
  const action = text(input.action);
  if (!ACTIONS.includes(action)) return refusal('action must be add, change or remove.', 'invalid_input');
  const fields = ['name', 'phone', 'email'].filter((k) => input[k] !== undefined && input[k] !== null);
  const relationship = text(input.relationship);
  if (relationship && !RELATIONSHIPS.includes(relationship)) return refusal(`relationship must be one of: ${RELATIONSHIPS.join(', ')}.`, 'invalid_input');
  const next = slots.map((s) => ({ name: s.name, phone: s.phone, email: s.email }));
  if (action === 'add') {
    if (!text(input.name)) return refusal('Give the new contact\'s name.', 'invalid_input');
    if (!relationship) return refusal('Ask who the new contact is to the account (spouse or partner, family member, tenant, and so on), then pass relationship.', 'invalid_input');
    if (!text(input.phone) && !text(input.email)) return refusal('Give the new contact\'s phone number or email (or both).', 'invalid_input');
    const index = slots.findIndex((s) => !isFilled(s));
    if (index < 0) return refusal('This account already has three contacts. Change or remove one first.', 'slots_full');
    next[index] = { name: text(input.name), phone: text(input.phone), email: text(input.email) };
    return { action, index, next, roles: { [index]: relationship } };
  }
  const index = Number(input.slot) - 1;
  const listed = contactList(slots);
  if (![0, 1, 2].includes(index)) {
    return refusal(listed.length ? 'Give the slot (1, 2 or 3) of the contact to change or remove. The contacts on file are listed.' : 'This account has no extra contacts.', 'invalid_input', { contacts: listed });
  }
  if (!isFilled(slots[index])) return refusal(`Contact ${index + 1} is empty on this account. The contacts on file are listed.`, 'slot_empty', { contacts: listed });
  if (action === 'remove') {
    next[index] = { name: '', phone: '', email: '' };
    return { action, index, next, roles: {} };
  }
  if (!fields.length && !relationship) return refusal('Give the name, phone, email or relationship that changes.', 'invalid_input');
  for (const k of fields) next[index][k] = text(input[k]);
  if (!isFilled(next[index])) return refusal('That would leave the contact empty. Use action "remove" instead.', 'invalid_input');
  return { action, index, next, roles: relationship ? { [index]: relationship } : {} };
}

// The columns the handler would write for this body, run through the route's own normalizer and compactor on the
// same stored row, so the card shows exactly what the save stores.
function plannedWrite(customer, next, roles) {
  const { SERVICE_CONTACT_SLOT_FIELDS, normalizeChangedServiceContacts, compactServiceContactSlots } = routePrivate();
  const updates = {};
  SERVICE_CONTACT_SLOT_FIELDS.forEach(([n, p, e], i) => {
    updates[n] = next[i].name;
    updates[p] = next[i].phone;
    updates[e] = next[i].email;
  });
  const problem = normalizeChangedServiceContacts(updates, customer);
  if (problem) return { problem };
  // The handler applies the card's roles the same way, before compaction (req.ibServiceContactRoles).
  for (const [index, role] of Object.entries(roles)) updates[SERVICE_CONTACT_SLOT_FIELDS[index][3]] = role;
  // Each slot as the save formats it, before compaction moves anyone up. A slot the card gives no role keeps the role
  // its person had (the compactor's rule), shown from the stored row.
  const formatted = storedSlots(updates).map((slot, i) => (roles[i] ? slot : { ...slot, role: text(customer[SERVICE_CONTACT_SLOT_FIELDS[i][3]]) || null }));
  compactServiceContactSlots(updates, customer);
  return { updates, formatted, after: storedSlots(updates) };
}

// A person already on the account (the holder or another slot) by phone or email.
function duplicateOf(customer, slots, index, person) {
  const key = phoneKey(person.phone);
  const mail = text(person.email).toLowerCase();
  if (key && key === phoneKey(customer.phone)) return 'the account holder\'s phone';
  if (mail && mail === text(customer.email).toLowerCase()) return 'the account holder\'s email';
  const other = slots.findIndex((s, i) => i !== index && isFilled(s)
    && ((key && phoneKey(s.phone) === key) || (mail && text(s.email).toLowerCase() === mail)));
  return other >= 0 ? `contact ${other + 1} (${slots[other].name || 'no name'})` : null;
}

// What the contact gets by email, in the senders' own terms: appointment emails follow the account's notification
// settings and the contact's own choices; service reports also skip a tenant (slotWithheldFromReports).
function emailLine(customer, target) {
  if (!target.email) return null;
  const { slotWithheldFromReports } = require('../customer-contact');
  const reports = slotWithheldFromReports(customer, { contactRole: target.role })
    ? 'but no service reports (a tenant, or an account a property manager holds)'
    : 'and service reports';
  return { kind: 'comms', text: `${target.email} can get this account's appointment emails ${reports}, as the account's notification settings and the contact's own choices allow.` };
}

// Texts, by the senders' consent rule (customer-contact.js serviceContactsConsented, which its kill switch can turn off).
function textLine({ plan, consentOnFile, consentCleared }) {
  const { serviceContactsConsented } = require('../customer-contact');
  if (serviceContactsConsented({ service_contacts_consent_at: null })) {
    return { kind: 'comms', text: 'Texts to contacts follow the account\'s notification settings (the contact consent check is switched off).' };
  }
  if (consentCleared) return { kind: 'comms', text: 'Clears the texting consent on file for this account\'s contacts: no contact gets texts until they agree again in the app. The account holder\'s texts do not change.' };
  if (!consentOnFile && plan.action !== 'remove') return { kind: 'comms', text: 'No contact gets texts until they agree to texts in the app. The account holder\'s texts do not change.' };
  return null;
}

function planEffects({ customer, name, before, after, target, plan, consentOnFile, consentCleared }) {
  const listed = after.filter(isFilled);
  const lines = [
    { kind: 'operational', text: listed.length
      ? `Contacts on ${name || 'this account'} after this: ${listed.map((s, i) => `${i + 1}. ${describe(s)}`).join('; ')}.`
      : `${name || 'This account'} has no extra contacts after this.` },
  ];
  if (plan.action === 'remove') {
    lines.push({ kind: 'comms', text: `${target.name || 'This contact'} stops getting this account's emails and texts.` });
  } else {
    lines.push(emailLine(customer, target));
  }
  lines.push(textLine({ plan, consentOnFile, consentCleared }));
  // The handler prunes the removed phone's own notification choices and revokes its app sessions; a later re-add
  // starts fresh.
  const oldPhone = before[plan.index].phone;
  if (oldPhone && (plan.action === 'remove' || phoneKey(oldPhone) !== phoneKey(target.phone))) {
    lines.push({ kind: 'operational', text: `${before[plan.index].name || 'This contact'} on ${oldPhone} is signed out of the app, and their push alerts and own notification choices are removed. Adding them back later does not restore those.` });
  }
  lines.push({ kind: 'comms', text: 'Nothing is sent now: no text, email or call goes to anyone.' });
  lines.push({ kind: 'operational', text: 'To undo, edit the contacts on the customer page.' });
  return lines;
}

async function buildPlan(input, { database = db } = {}) {
  const id = text(input?.customer_id);
  if (!UUID_RE.test(id)) return refusal('customer_id must be a customer id. Find the customer with query_customers first.', 'invalid_input');
  const customer = await database('customers').where({ id }).whereNull('deleted_at').first();
  if (!customer) return refusal('No live customer has that id.', 'not_found');
  const before = storedSlots(customer);
  const plan = requestedSlots(before, input);
  if (plan.error) return plan;
  if (plan.action !== 'remove') {
    const dupe = duplicateOf(customer, before, plan.index, plan.next[plan.index]);
    if (dupe) return refusal(`That phone or email is already on this account as ${dupe}. Change that contact instead.`, 'already_on_account');
  }
  const { problem, updates, formatted, after } = plannedWrite(customer, plan.next, plan.roles);
  if (problem) return refusal(problem.error, 'invalid_contact');
  const name = customerName(customer);
  const consentOnFile = !!customer.service_contacts_consent_at;
  const consentCleared = consentOnFile && updates.service_contacts_consent_at === null;
  const body = {};
  BODY_KEYS.forEach((keys, i) => keys.forEach((key, k) => { body[key] = [plan.next[i].name, plan.next[i].phone, plan.next[i].email][k]; }));
  const target = plan.action === 'remove' ? before[plan.index] : formatted[plan.index];
  const verb = { add: 'Add', change: 'Change', remove: 'Remove' }[plan.action];
  return {
    preview: true,
    tool: 'set_customer_service_contact',
    customer_id: customer.id,
    customer_name: name,
    action: plan.action,
    summary: `${verb} contact${plan.action === 'add' ? '' : ` ${plan.index + 1}`}: ${describe(target)}`,
    contacts_before: before.filter(isFilled).map(describe),
    contacts_after: after.filter(isFilled).map(describe),
    effects: planEffects({ customer, name, before, after, target, plan, consentOnFile, consentCleared }).filter(Boolean),
    sends_to_customer: false,
    // What the confirm and the locked re-check compare: the customer, the stored slots, the stamp and the write.
    _version: { customer_id: customer.id, customer_name: name, before, consent_on_file: consentOnFile, body, roles: plan.roles, after },
    note: 'PREVIEW ONLY — nothing was changed. Confirm saves exactly these contacts; if anything changed it refuses.',
  };
}

async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this contact change.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The customer\'s contacts changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// The card re-derived INSIDE the handler's transaction, on the customer row it already holds FOR UPDATE: a contact
// edit that landed after the card refuses as preview_changed and the save rolls back.
function lockedPlanCheck(input, pinned) {
  return async (trx) => {
    const plan = await buildPlan(input, { database: trx });
    if (plan.error || JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
      throw Object.assign(new Error('The customer\'s contacts changed after the card was shown.'), {
        statusCode: 409, isOperational: true, code: 'preview_changed',
      });
    }
  };
}

const sameSlots = (a, b) => JSON.stringify(a.map(({ name, phone, email, role }) => [name, phone, email, role]))
  === JSON.stringify(b.map(({ name, phone, email, role }) => [name, phone, email, role]));

async function commitContacts(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_service_contact_version);
  if (refused) return refused;
  const base = { customer_id: plan.customer_id };
  const interrupted = { ...base, outcome_unknown: true, code: 'execution_interrupted',
    error: 'The contact change was interrupted — it may or may not have happened. Check the customer page before trying again.' };
  let reply;
  try {
    reply = await require('../../routes/admin-customers').setServiceContactsFromBar({
      customerId: plan.customer_id,
      slots: plan._version.body,
      roles: plan._version.roles,
      verifyPlan: lockedPlanCheck(input, plan._version),
      actor: { technicianId: actionContext?.technicianId || null },
    });
  } catch (err) {
    if (err?.code === 'preview_changed') {
      return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: 'The customer\'s contacts changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };
    }
    logger.error(`[intelligence-bar:service-contact] handler failed (${err?.code || err?.name || 'error'})`);
    return interrupted;
  }
  if (reply.status !== 200) {
    return { ...base, failed: true, code: reply.status === 404 ? 'not_found' : 'contact_refused',
      error: `The contacts were not changed: ${String(reply.json?.error || reply.json?.message || 'the customer page refused it')}` };
  }
  const now = await db('customers').where({ id: plan.customer_id }).first().catch(() => null);
  if (!now || !sameSlots(storedSlots(now), plan._version.after)) {
    return { ...base, outcome_unknown: true, code: 'contact_unverified',
      error: 'The customer page answered, but the contacts do not read as the card showed. Check the customer page before trying again.' };
  }
  logger.info(`[intelligence-bar:service-contact] customer ${plan.customer_id} contacts ${plan.action}`);
  return { ...base, success: true, sent_to_customer: false, contacts: plan.contacts_after,
    note: `Saved. ${plan.summary}. Nothing was sent to anyone.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'set_customer_service_contact' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'operational', text: `${preview.summary} on ${preview.customer_name || preview.customer_id}` },
    ...(preview.effects || []).map(({ kind, text: line }) => ({ kind, text: line })),
  ];
}

async function executeServiceContactTool(toolName, input = {}, actionContext = {}) {
  if (!SERVICE_CONTACT_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the customer page's editor (requireAdmin); the confirmed run needs a positive admin flag.
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Changing a customer\'s contacts is limited to admin accounts', 'permission_denied');
  }
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitContacts(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:service-contact] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The contact change was interrupted — it may or may not have happened. Check the customer page before trying again.' }
      : { error: 'Could not prepare the contact change' };
  }
}

module.exports = {
  SERVICE_CONTACT_TOOLS,
  executeServiceContactTool,
  cardLines,
  lockedPlanCheck,
};
