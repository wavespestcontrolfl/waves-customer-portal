'use strict';

// The bell's Save to profile / One visit only buttons on the SMS reader's review bell ("Comms — check <name>'s
// text note", sms-operational-actions.js; owner 2026-11-02 "C": one tap saves the note or closes the alert;
// docs/admin-notifications.md section 2, part 9, kind text_note). Rides GATE_ALERT_CLOSE_BUTTONS with the close-only
// buttons. Save re-reads the held-back facts of the bell's source text and writes each one through the SMS lane's
// shared compare-and-set writer (data-hygiene/property-preferences.js), under the property-preferences lock the
// reader and Customer 360 take, then closes the bell on the version the tap claimed: a long-text note gets the text as
// a new "[text <date>]" line, any other field is filled only while it is empty. It sends nothing to a customer.

const db = require('../models/db');
const NotificationService = require('./notification-service');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

const KIND = 'text_note';
const ITEMS = {
  save: { label: 'Save to profile', resolution: 'Saved to profile' },
  one_visit: { label: 'One visit only', resolution: 'One visit only' },
};

// Both are stored on the bell when it is raised; visibleItems decides whether the bell shows Save.
const textNoteButtons = () => ({ kind: KIND, items: Object.entries(ITEMS).map(([id, { label }]) => ({ id, label })) });

// Notes a tech reads as running text: Save adds a dated line. Every other field the reader can propose (the four
// codes, the controller location, the contact preference) holds one value, so Save never overwrites one on file.
const LONG_TEXT_FIELDS = new Set(['special_instructions', 'access_notes', 'pet_details', 'parking_notes',
  'irrigation_schedule_notes', 'irrigation_issues']);
// A fact the reader could not pin to one value or one topic, or a "no" / "not sure" pet or irrigation report it held
// for a person to read (saving an irrigation note would also turn the system on): a person decides in the profile.
const NO_SAVE_OUTCOMES = new Set(['conflicting_facts', 'mixed_topics', 'value_too_long', 'changed_during_extraction',
  'pet_needs_review', 'irrigation_needs_review']);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// The facts the bell rang for: the held-back facts of its source text (a replay's when it ran one), in the fields
// the bell names.
function bellFacts(source, meta) {
  const { bellExceptions } = require('./sms-operational-actions');
  const analysis = source?.operational_analysis || {};
  const facts = Array.isArray(analysis.replay?.facts) ? analysis.replay.facts : analysis.facts;
  const fields = new Set(Array.isArray(meta.fields) ? meta.fields : []);
  return bellExceptions(Array.isArray(facts) ? facts : []).filter((f) => fields.has(f.field));
}

const normalized = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').toLowerCase();
const sameText = (a, b) => normalized(a) === normalized(b);
// A note already holds the text only as a whole line (its "[text <date>] " tag ignored), never as part of one:
// "Do not skip the shed" does not hold "Skip the shed".
const DATED_LINE = /^\[text \d{4}-\d{2}-\d{2}\]\s*/;
const holdsLine = (text, value) => String(text ?? '').split('\n').some((line) => sameText(line.replace(DATED_LINE, ''), value));

// The value Save writes for one fact, null when the profile already says it, or a refusal code.
function nextValue(fact, before, sourceAt) {
  const value = String(fact.value ?? '').trim();
  if (!value) return { refusal: 'nothing_to_save' };
  if (LONG_TEXT_FIELDS.has(fact.field)) {
    const text = String(before ?? '').trim();
    if (holdsLine(text, value)) return { value: null };
    const { etDateString } = require('../utils/datetime-et');
    // One line per text, so the whole-line check above finds it next time.
    const line = `[text ${etDateString(new Date(sourceAt))}] ${value.replace(/\s+/g, ' ')}`;
    return { value: text ? `${text}\n${line}` : line };
  }
  if (before == null || String(before).trim() === '') return { value };
  return sameText(before, value) ? { value: null } : { refusal: 'on_file', field: fact.field };
}

// The profile row is the customer's, not one property's, so Save writes only for a customer with exactly one
// active property now, and only facts that name no property or that one: whatever the reader's outcome says
// (a pet or irrigation review can carry no property), and whatever changed since the text was read.
const tiedToTheOneProperty = (facts, properties) => properties.length === 1
  && facts.every((f) => !f.property_id || String(f.property_id) === String(properties[0]));

// What Save would write: { writes: [{ field, value, fact }] } or { refusal, field? }. Pure; the tap runs it again
// under the lock on what it reads there. `properties`: the customer's active property ids.
function planSave({ meta, source, prefs, properties = [] }) {
  if (!source) return { refusal: 'gone' };
  // Save writes what the reader held back, so the reader's own off switch and activation time stop it too: the tap
  // reruns this under the lock, inside the save transaction (Codex Security r1 on #7494).
  if (!require('./sms-operational-actions').readerWritesTextFrom(source.created_at)) return { refusal: 'reader_off' };
  const facts = bellFacts(source, meta);
  if (!facts.length) return { refusal: 'nothing_to_save' };
  if (facts.some((f) => NO_SAVE_OUTCOMES.has(f.outcome))) return { refusal: 'open_profile' };
  if (!tiedToTheOneProperty(facts, properties)) return { refusal: 'property' };
  const { validatePrefsBody, PREFS_FIELD_SCHEMAS, snakeToCamel, transformKeys, camelToSnake, normalizeUpdatesForStorage }
    = require('./property-preferences-schema');
  const writes = [];
  const current = { ...(prefs || {}) };
  for (const fact of facts) {
    const next = nextValue(fact, current[fact.field] ?? null, source.created_at);
    if (next.refusal) return next;
    if (next.value === null) continue;
    const { value, rejected } = validatePrefsBody(PREFS_FIELD_SCHEMAS, { [snakeToCamel(fact.field)]: next.value });
    if (rejected.length || !(snakeToCamel(fact.field) in value)) return { refusal: 'invalid', field: fact.field };
    const stored = normalizeUpdatesForStorage(transformKeys(value, camelToSnake))[fact.field];
    writes.push({ field: fact.field, value: stored, fact });
    current[fact.field] = stored;
  }
  return { writes };
}

const label = (field) => require('./sms-operational-actions').reviewFieldLabel(field);
const REFUSALS = {
  gone: () => ({ message: 'The text or the customer is no longer on file.', close: 'Text or customer no longer on file' }),
  reader_off: () => ({ message: 'The SMS reader is off for this text, so Save is off. Open the profile to save it.' }),
  nothing_to_save: () => ({ message: 'Nothing in this text is left to save. Open the conversation to check.' }),
  open_profile: () => ({ message: 'This text needs a person to pick what to save. Open the profile to save it.' }),
  property: () => ({ message: 'This note is not tied to the customer\'s one property. Open the profile to save it there.' }),
  on_file: (field) => ({ message: `The profile already has a ${label(field)}. Open the profile to change it.` }),
  invalid: (field) => ({ message: `The ${label(field)} cannot take this text. Open the profile to edit it.` }),
};
const refuse = ({ refusal, field }) => ({ ok: false, code: refusal, ...REFUSALS[refusal](field) });

// The inputs planSave reads, for every bell on a page at once.
async function loadPlanInputs(conn, metas) {
  const smsIds = [...new Set(metas.map((m) => m.sms_log_id).filter(Boolean).map(String))];
  const customerIds = [...new Set(metas.map((m) => m.customerId).filter(Boolean).map(String))];
  const [sources, prefs, properties] = await Promise.all([
    smsIds.length ? excludeUnresolvedSendReservations(conn('sms_log').whereIn('id', smsIds))
      .select('id', 'customer_id', 'created_at', 'operational_analysis') : [],
    customerIds.length ? conn('property_preferences').whereIn('customer_id', customerIds).select('*') : [],
    customerIds.length ? conn('customer_properties').whereIn('customer_id', customerIds).where({ active: true })
      .select('id', 'customer_id') : [],
  ]);
  return {
    source: (m) => sources.find((s) => String(s.id) === String(m.sms_log_id) && String(s.customer_id) === String(m.customerId)) || null,
    prefs: (m) => prefs.find((p) => String(p.customer_id) === String(m.customerId)) || null,
    properties: (m) => properties.filter((p) => String(p.customer_id) === String(m.customerId)).map((p) => String(p.id)),
  };
}

// Serving the bell: Save shows only while it would write something; One visit only always shows.
async function visibleItems(rows) {
  const metas = rows.map((row) => parseMetadata(row.metadata));
  const inputs = await loadPlanInputs(db, metas);
  return new Map(rows.map((row, i) => {
    const meta = metas[i];
    const plan = planSave({ meta, source: inputs.source(meta), prefs: inputs.prefs(meta), properties: inputs.properties(meta) });
    return [row.id, plan.writes?.length ? ['save', 'one_visit'] : ['one_visit']];
  }));
}

// Closes the bell on the version this tap claimed, so a bell an emitter rewrote meanwhile is never closed unseen.
async function closeClaimed(conn, row, { technicianId, claimedVersion, resolution }) {
  return NotificationService.markAdminDone([row.id], {
    by: String(technicianId), resolution, role: 'admin', expectedVersion: claimedVersion,
  }, conn);
}

const CHANGED = Object.freeze({ ok: false, code: 'changed' });

async function save({ row, technicianId, claimedVersion }) {
  const meta = parseMetadata(row.metadata);
  const customerId = meta.customerId ? String(meta.customerId) : null;
  if (!customerId || !meta.sms_log_id) return refuse({ refusal: 'gone' });
  const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('./data-hygiene/property-preferences');
  const { stalePendingExtractionProposals } = require('./data-hygiene/proposal-store');
  const { recordAuditEvent } = require('./audit-log');
  try {
    return await db.transaction(async (trx) => {
      // The reader's lock order: the preference advisory lock, the customer, then its rows.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', customerId]);
      const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
      const inputs = await loadPlanInputs(trx, [meta]);
      const source = customer ? inputs.source(meta) : null;
      const plan = planSave({ meta, source, prefs: inputs.prefs(meta), properties: inputs.properties(meta) });
      if (plan.refusal) return refuse(plan);
      let before = inputs.prefs(meta);
      for (const write of plan.writes) {
        const target = await resolvePropertyPreferencesTarget({ trx,
          proposal: { scope_id: customerId, field: write.field, resource_id: before?.id || null },
          currentRaw: before?.[write.field] ?? null });
        await applyPropertyPreferenceValue({ trx, proposal: { scope_id: customerId, field: write.field }, target, proposedRaw: write.value });
        // A pending proposal for this field would fail its before-value check now (the reader's own step).
        await stalePendingExtractionProposals({ trx, scope_id: customerId, field: write.field });
        await recordAuditEvent({ trx, critical: true, actor_type: 'technician', actor_id: String(technicianId),
          action: 'sms.property_preference.updated', resource_type: 'property_preferences', resource_id: target.id,
          metadata: { sms_log_id: String(meta.sms_log_id), customer_id: customerId, property_id: write.fact.property_id || null,
            field: write.field, via: 'text_note_button', notification_id: String(row.id) } });
        before = { ...target, [write.field]: write.value };
      }
      if (!(await closeClaimed(trx, row, { technicianId, claimedVersion, resolution: ITEMS.save.resolution }))) {
        throw Object.assign(new Error('bell changed'), { code: 'TEXT_NOTE_CHANGED' });
      }
      return { ok: true, closed: true, message: 'Saved to the profile.', resolution: ITEMS.save.resolution };
    });
  } catch (err) {
    // The bell changed after the claim, or the profile changed under the compare-and-set: nothing was saved.
    if (err.code === 'TEXT_NOTE_CHANGED' || err.status === 409) return CHANGED;
    throw err;
  }
}

async function run({ row, item, technicianId, claimedVersion }) {
  if (!Object.hasOwn(ITEMS, item.id)) return { ok: false, code: 'unknown_action', message: 'This button is not known.' };
  if (item.id === 'save') return save({ row, technicianId, claimedVersion });
  if (!(await closeClaimed(db, row, { technicianId, claimedVersion, resolution: ITEMS.one_visit.resolution }))) return CHANGED;
  return { ok: true, closed: true, message: 'Closed: one visit only.', resolution: ITEMS.one_visit.resolution };
}

const buttonHandler = {
  live: () => require('../config/feature-gates').alertCloseButtonsLive(),
  visibleItems,
  run,
};

module.exports = { KIND, textNoteButtons, buttonHandler, _private: { planSave, nextValue, LONG_TEXT_FIELDS, NO_SAVE_OUTCOMES } };
