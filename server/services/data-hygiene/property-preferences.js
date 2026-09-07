'use strict';

const { IRRIGATION_INPUT_FIELDS } = require('../irrigation-schedule-confirmation');

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
async function applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw }) {
  const irrigation = IRRIGATION_INPUT_FIELDS.includes(proposal.field);
  const companions = irrigation && target.irrigation_system !== true
    ? { irrigation_system: target.irrigation_system ?? null } : {};
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
// holds the value apply set: a later deliberate change survives the revert.
async function revertPropertyPreferenceCompanions({ trx, proposal, target, companions = {} }) {
  if (!('irrigation_system' in companions) || target.irrigation_system !== true) return { reverted: [] };
  await trx('property_preferences')
    .where({ id: target.id, customer_id: proposal.scope_id })
    .update({ irrigation_system: companions.irrigation_system, updated_at: trx.fn.now() });
  return { reverted: ['irrigation_system'] };
}

function valuesEqual(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

module.exports = { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue, revertPropertyPreferenceCompanions, valuesEqual };
