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
 * Descriptions AND metadata carry only masked identifiers (first name +
 * last initial, first-letter-masked email, last-4 phone): descriptions ride
 * global surfaces (the dashboard recentActivity feed, the IB briefing), and
 * no current reader needs the full values — the timeline selects only
 * action/description/created_at. The Phase 2 People panel can move to full
 * detail forward-only when its consumer ships. The dashboard feed
 * additionally strips metadata from service_contact_* rows
 * (routes/admin-dashboard.js) as defense in depth.
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
  dedupe_undo: 'account merge undo',
  call: 'call pipeline',
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

// How strongly an after-person and a before-person look like the same
// human: count of agreeing identifiers, with email > phone > name breaking
// equal-count ties. 0 = no shared identifier (never a match).
function pairRank(person, candidate) {
  const emailHit = norm(person.email) && norm(person.email) === norm(candidate.email) ? 1 : 0;
  const phoneHit = phoneKey(person.phone) && phoneKey(person.phone) === phoneKey(candidate.phone) ? 1 : 0;
  const nameHit = norm(person.name) && norm(person.name) === norm(candidate.name) ? 1 : 0;
  const score = emailHit + phoneHit + nameHit;
  return score ? score * 8 + emailHit * 4 + phoneHit * 2 + nameHit : 0;
}

// Choose the identity pairing that maximizes TOTAL rank across all people
// at once, not greedily per person — a greedy pass can hand one person's
// strongest candidate to somebody else when identifiers move between
// household members in a single save (e.g. Jane taking Bob's phone while
// Bob drops a shared email). At most 3 slots per side, so brute force is
// exact and cheap. First assignment found with the max total wins, which is
// deterministic (earlier after-slots try earlier before-slots first).
function bestAssignment(afterPeople, beforePeople) {
  let best = { total: 0, pairs: [] };
  const used = new Array(beforePeople.length).fill(false);
  const pairs = [];
  const walk = (i, total) => {
    if (i === afterPeople.length) {
      if (total > best.total) best = { total, pairs: pairs.slice() };
      return;
    }
    walk(i + 1, total); // afterPeople[i] left unmatched
    for (let j = 0; j < beforePeople.length; j += 1) {
      if (used[j]) continue;
      const rank = pairRank(afterPeople[i], beforePeople[j]);
      if (!rank) continue;
      used[j] = true;
      pairs.push([i, j]);
      walk(i + 1, total + rank);
      pairs.pop();
      used[j] = false;
    }
  };
  walk(0, 0);
  return best.pairs;
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
  const matchedAfter = new Set();
  const matchedBefore = new Set();

  for (const [i, j] of bestAssignment(afterPeople, beforePeople)) {
    matchedAfter.add(i);
    matchedBefore.add(j);
    const changed = changedFields(beforePeople[j], afterPeople[i]);
    if (changed.length) {
      events.push({ action: 'service_contact_updated', person: afterPeople[i], changed });
    }
  }

  // Same-slot fallback: a name-only contact (no phone, no email) that is
  // renamed can't match on any stable identifier and would read as
  // remove+add. When BOTH the unmatched after-person and the unmatched
  // before-person in the same slot lack stable identifiers, the slot is the
  // only identity evidence — treat it as an update. A person with a phone or
  // email that stopped matching really is a different person: no fallback.
  const hasStableId = (p) => !!(phoneKey(p.phone) || norm(p.email));
  for (let i = 0; i < afterPeople.length; i += 1) {
    if (matchedAfter.has(i)) continue;
    const person = afterPeople[i];
    const j = beforePeople.findIndex((p, idx) => !matchedBefore.has(idx) && p.slot === person.slot);
    if (j !== -1 && !hasStableId(person) && !hasStableId(beforePeople[j])) {
      matchedBefore.add(j);
      events.push({ action: 'service_contact_updated', person, changed: changedFields(beforePeople[j], person) });
      continue;
    }
    events.push({ action: 'service_contact_added', person, changed: [] });
  }

  for (let j = 0; j < beforePeople.length; j += 1) {
    if (!matchedBefore.has(j)) {
      events.push({ action: 'service_contact_removed', person: beforePeople[j], changed: [] });
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
 * @param {Date}   [args.occurredAt]     timestamp captured while the save held
 *                                       the customer row lock. The lock
 *                                       serializes concurrent saves, so
 *                                       stamping it as created_at keeps the
 *                                       timeline order matching the transition
 *                                       order even when a later save's
 *                                       post-commit insert lands first.
 */
async function recordServiceContactChanges({
  customerId,
  before = {},
  after = {},
  source = 'portal',
  actorCustomerId = null,
  adminUserId = null,
  occurredAt = null,
} = {}) {
  try {
    const events = diffServiceContacts(before, after);
    if (!events.length) return [];
    let sourceLabel = SOURCE_LABELS[source] || source;
    // Staff-initiated events name the acting staff member in the visible
    // description — the timeline renders only descriptions, and "who made
    // the change" is the point of the audit trail. Applies to any source
    // with an acting admin (admin edits, manual merges/undos); automated
    // paths pass no adminUserId and keep the generic label. Staff names are
    // not customer PII (the dashboard already shows technician names).
    // Best-effort: a failed lookup keeps the generic label.
    if (adminUserId) {
      try {
        const tech = await db('technicians').where({ id: adminUserId }).first('name');
        if (tech && tech.name) sourceLabel = `${sourceLabel}: ${tech.name}`;
      } catch (err) {
        // keep the generic label
      }
    }
    await db('activity_log').insert(events.map((event) => ({
      customer_id: customerId,
      admin_user_id: adminUserId || null,
      action: event.action,
      description: describeEvent(event, sourceLabel),
      metadata: JSON.stringify({
        slot: event.person.slot,
        // Masked like the description: no reader needs the full values today
        // (the timeline selects action/description/created_at), so retaining
        // full third-party PII would serve only the unbuilt Phase 2 People
        // panel — which can switch to full detail forward-only when its
        // consumer actually ships and is reviewed.
        name: maskName(event.person.name) || null,
        phone: maskPhone(event.person.phone) || null,
        email: maskEmail(event.person.email) || null,
        role: event.person.role || null,
        source,
        actor_customer_id: actorCustomerId,
        admin_user_id: adminUserId,
        consent_text_version: after.service_contacts_consent_text_version || null,
        changed_fields: event.changed,
      }),
      ...(occurredAt ? { created_at: occurredAt } : {}),
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
