/**
 * Service-contact change events for the Customer 360 timeline.
 *
 * The on-location contact slots are the one piece of customer-editable data
 * with no audit trail: the account.updated "was this you?" email is skipped
 * for self-initiated portal saves by design, so a family member added in the
 * portal left no visible record of who added them, when, or how. This module
 * closes that gap by diffing the slots around a save and writing one
 * activity_log row per real change — the admin timeline already renders
 * activity_log rows, so events surface with no UI changes.
 *
 * Identity matching mirrors the save paths' own slot matching (phone key →
 * email → exact name; see serviceContactSlotUpdates in routes/notifications.js
 * and compactServiceContactSlots in routes/admin-customers.js): a person
 * shifted to a different slot by a delete-compaction is the same person, not
 * a remove + add.
 *
 * Best-effort by design: callers invoke this AFTER their write commits, and
 * any failure only warns — a logging failure must never fail the customer's
 * save (same posture as the account.updated email dispatch).
 *
 * Descriptions carry only masked identifiers (first name + last initial,
 * first-letter-masked email, last-4 phone) because they ride global
 * surfaces — the dashboard recentActivity feed and the IB briefing. The
 * full contact detail lives in metadata — the People panel (Phase 2) needs
 * it for removed-contact history, which no other table retains. Both the
 * timeline endpoint and the raw table are admin-only, and the dashboard
 * feed strips metadata from service_contact_* rows
 * (routes/admin-dashboard.js) so full detail stays scoped to the
 * customer's own timeline.
 */
const db = require('../models/db');
const logger = require('./logger');
const { getServiceContactSlots } = require('./customer-contact');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const phoneKey = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const maskPhone = (v) => {
  const key = phoneKey(v);
  return key ? `…${key.slice(-4)}` : '';
};
// Descriptions ride the GLOBAL recent-activity feed and the IB briefing, so
// they carry no full identifiers (matching the rest of activity_log): first
// name + last initial, first-letter-masked email, last-4 phone. The full
// contact lives in metadata, which global consumers strip.
const maskName = (v) => {
  const parts = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};
const maskEmail = (v) => {
  const s = String(v == null ? '' : v).trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '…' : '';
  return `${s[0]}…${s.slice(at)}`;
};

const SOURCE_LABELS = {
  portal: 'customer portal',
  admin: 'admin',
  dedupe: 'account merge',
};

// Populated slots as people: {slot, name, phone, email, role}.
function slotPeople(customerRow) {
  return getServiceContactSlots(customerRow)
    .map((slot, i) => ({
      slot: i + 1,
      name: slot.name,
      phone: slot.phone,
      email: slot.email,
      role: slot.contactRole,
    }))
    .filter((p) => p.name || p.phone || p.email);
}

function matchPerson(person, candidates) {
  return candidates.find((c) => phoneKey(person.phone) && phoneKey(person.phone) === phoneKey(c.phone))
    || candidates.find((c) => norm(person.email) && norm(person.email) === norm(c.email))
    || candidates.find((c) => norm(person.name) && norm(person.name) === norm(c.name))
    || null;
}

function changedFields(beforePerson, afterPerson) {
  const fields = [];
  if (norm(beforePerson.name) !== norm(afterPerson.name)) fields.push('name');
  if (phoneKey(beforePerson.phone) !== phoneKey(afterPerson.phone)) fields.push('phone');
  if (norm(beforePerson.email) !== norm(afterPerson.email)) fields.push('email');
  if (norm(beforePerson.role) !== norm(afterPerson.role)) fields.push('role');
  return fields;
}

// Diff two customers rows' contact slots into person-level events. Slot
// shifts produce nothing; only a genuinely new / changed / gone person does.
function diffServiceContacts(beforeRow = {}, afterRow = {}) {
  const beforePeople = slotPeople(beforeRow);
  const afterPeople = slotPeople(afterRow);
  const events = [];
  const matched = new Set();

  for (const person of afterPeople) {
    const prior = matchPerson(person, beforePeople.filter((p) => !matched.has(p)));
    if (!prior) {
      events.push({ action: 'service_contact_added', person, changed: [] });
      continue;
    }
    matched.add(prior);
    const changed = changedFields(prior, person);
    if (changed.length) {
      events.push({ action: 'service_contact_updated', person, changed });
    }
  }

  for (const prior of beforePeople) {
    if (!matched.has(prior)) {
      events.push({ action: 'service_contact_removed', person: prior, changed: [] });
    }
  }

  return events;
}

function displayName(person) {
  return maskName(person.name) || maskEmail(person.email) || (person.phone ? maskPhone(person.phone) : 'Contact');
}

function describeEvent(event, sourceLabel) {
  const name = displayName(event.person);
  const phone = event.person.phone && event.person.name ? ` (${maskPhone(event.person.phone)})` : '';
  if (event.action === 'service_contact_added') {
    return `${name}${phone} added as on-location contact — ${sourceLabel}`;
  }
  if (event.action === 'service_contact_removed') {
    return `${name} removed as on-location contact — ${sourceLabel}`;
  }
  return `On-location contact ${name} updated (${event.changed.join(', ')}) — ${sourceLabel}`;
}

/**
 * Diff before/after contact slots and record one activity_log row per real
 * change. Call after the save's transaction commits. Never throws.
 *
 * @param {object} args
 * @param {string} args.customerId       property profile the contacts live on
 * @param {object} args.before           customers row before the save
 * @param {object} args.after            customers row after the save (merge
 *                                       the written columns over `before`)
 * @param {string} args.source           'portal' | 'admin' | 'dedupe'
 * @param {string} [args.actorCustomerId] portal saves: the authenticated customer
 * @param {string} [args.adminUserId]    admin saves: technicians.id (activity_log FK)
 */
async function recordServiceContactChanges({
  customerId,
  before = {},
  after = {},
  source = 'portal',
  actorCustomerId = null,
  adminUserId = null,
} = {}) {
  try {
    const events = diffServiceContacts(before, after);
    if (!events.length) return [];
    const sourceLabel = SOURCE_LABELS[source] || source;
    await db('activity_log').insert(events.map((event) => ({
      customer_id: customerId,
      admin_user_id: adminUserId || null,
      action: event.action,
      description: describeEvent(event, sourceLabel),
      metadata: JSON.stringify({
        slot: event.person.slot,
        name: event.person.name || null,
        phone: event.person.phone || null,
        email: event.person.email || null,
        role: event.person.role || null,
        source,
        actor_customer_id: actorCustomerId,
        admin_user_id: adminUserId,
        consent_text_version: after.service_contacts_consent_text_version || null,
        changed_fields: event.changed,
      }),
    })));
    return events;
  } catch (err) {
    logger.warn(`[service-contact-events] activity_log insert failed for customer ${customerId}: ${err.message}`);
    return [];
  }
}

module.exports = {
  recordServiceContactChanges,
  diffServiceContacts,
};
