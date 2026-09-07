'use strict';

const { IRRIGATION_INPUT_FIELDS, parseConfirmedFields } = require('../irrigation-schedule-confirmation');

// Shared compare-and-set writer for private property preferences.
// Callers own authorization, field allowlists, the transaction and audit.
async function resolvePropertyPreferencesTarget({ trx, proposal, currentRaw }) {
  const existing = proposal.resource_id
    ? await trx('property_preferences')
      .where({ id: proposal.resource_id, customer_id: proposal.scope_id })
      .forUpdate()
      .first()
    : await trx('property_preferences')
      .where({ customer_id: proposal.scope_id })
      .forUpdate()
      .first();

  if (existing) {
    const actual = existing[proposal.field] === undefined ? null : existing[proposal.field];
    if (!valuesEqual(actual, currentRaw)) {
      const err = new Error('Proposal is stale; current field value changed');
      err.status = 409;
      throw err;
    }
    return existing;
  }

  if (currentRaw !== null && currentRaw !== undefined) {
    const err = new Error('Cannot create property preferences row for a non-empty before value');
    err.status = 409;
    throw err;
  }

  const [created] = await trx('property_preferences')
    .insert({ customer_id: proposal.scope_id })
    .returning('*');
  return created;
}

// An irrigation input implies an active system. The flip is reported back so
// the apply audit can record it and a revert can restore it.
const hasValue = (value) => !(value === null || value === undefined || value === '' || value === false
  || (Array.isArray(value) && value.length === 0));

// Values, not just names: an edit to a pre-existing input after approval is
// affirmative irrigation evidence too.
const irrigationEvidence = (target, field) => ({
  inputs: Object.fromEntries(IRRIGATION_INPUT_FIELDS
    .filter((candidate) => candidate !== field && hasValue(target[candidate]))
    .map((candidate) => [candidate, target[candidate]])),
  confirmed: parseConfirmedFields(target.irrigation_confirmed_fields),
});

async function applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw }) {
  const irrigation = IRRIGATION_INPUT_FIELDS.includes(proposal.field);
  // The baseline lets a revert tell evidence that already existed (a legacy
  // row can hold inputs with the flag off) from evidence added afterwards.
  const companions = irrigation && target.irrigation_system !== true
    ? { irrigation_system: target.irrigation_system ?? null, irrigation_baseline: irrigationEvidence(target, proposal.field) } : {};
  const updated = await trx('property_preferences')
    .where({ id: target.id, customer_id: proposal.scope_id })
    .update({
      [proposal.field]: proposedRaw,
      ...(irrigation ? { irrigation_system: true } : {}),
      updated_at: trx.fn.now(),
    });
  if (!updated) {
    const err = new Error('Property preferences update failed');
    err.status = 409;
    throw err;
  }
  return { companions };
}

// Undo a companion flip recorded at apply time, only while the flag still
// holds the value apply set and nothing later confirmed irrigation: another
// irrigation input on the row or a portal confirmation keeps the system on.
async function revertPropertyPreferenceCompanions({ trx, proposal, target, companions = {} }) {
  if (!('irrigation_system' in companions) || target.irrigation_system !== true) return { reverted: [] };
  const now = irrigationEvidence(target, proposal.field);
  const baseline = companions.irrigation_baseline || { inputs: {}, confirmed: [] };
  const laterEvidence = Object.entries(now.inputs).some(([field, value]) => !(field in baseline.inputs) || !valuesEqual(value, baseline.inputs[field]))
    || now.confirmed.some((field) => !baseline.confirmed.includes(field));
  if (laterEvidence) return { reverted: [], retained: { irrigation_system: 'later_irrigation_evidence' } };
  await trx('property_preferences')
    .where({ id: target.id, customer_id: proposal.scope_id })
    .update({ irrigation_system: companions.irrigation_system, updated_at: trx.fn.now() });
  return { reverted: ['irrigation_system'] };
}

function valuesEqual(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

module.exports = { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue, revertPropertyPreferenceCompanions, valuesEqual };
