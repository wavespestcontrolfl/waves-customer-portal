/**
 * One-time fill: four churned customers picked a cancel reason that never reached customers.churn_reason_code (the processor did
 * not copy the pick until this change; cancellation-processor.js now does, through services/churn-reason-map.js).
 *
 * The rows are the ones a read-only production dry run selected on 2026-11-19: churned, code 'unclassified', and a whole-account,
 * committed cancellation case for THIS churn (three named by the request in churn_reason_detail, one the only case at the churn)
 * that holds a pick. Listing them, instead of inferring them here, keeps the fill to exactly what was checked.
 *
 * Each row is written only while it is still that churn: same churn_episode_id and churned_at, stage 'churned', code
 * 'unclassified'. Anywhere the ids do not exist (dev, preview), nothing changes. `to` is CANCEL_TO_CHURN[caseReason] from
 * services/churn-reason-map.js. One audit_log event per row (critical: a lost event fails the migration).
 *
 * down() puts 'unclassified' back on a row up() wrote (its audit event, not yet rolled back) while the row still holds this
 * migration's code in the same churn episode. It appends a :rollback event for every write it closes, restored or not (a row
 * corrected since is left, marked skipped), so a later correction back to the same code is never taken for this write
 * (audit_log is append-only).
 */
const MIGRATION = '20261120090000_churn_code_four_picked_cancels';
const LOG = '[churn-code-four-picked-cancels]';
const ACTION = `migration:${MIGRATION}:customer`;
const ROLLBACK_ACTION = `${ACTION}:rollback`;
const FROM = 'unclassified';

const ROWS = Object.freeze([
  { id: '580a43b0-be21-4375-83bc-644df53f53a1', episode: '8020f01e-10af-449f-80eb-742ea8ed25fa', churnedAt: '2026-09-21', caseId: '4ced4ade-7a70-482c-9a24-60ea236e929f', caseReason: 'no_longer_needed', to: 'no_longer_needed' },
  { id: '02c6ce1a-cef1-449d-8fd2-ca137a2c3b59', episode: 'ec60ee74-b1da-4319-9018-24636639871d', churnedAt: '2026-09-23', caseId: '15d20399-ce9d-4623-aa3a-a219a4891a44', caseReason: 'moving_or_property_change', to: 'moving' },
  { id: '35fd6604-65d4-4afb-a332-472ad95e9875', episode: 'd6ce5991-234d-4a45-a7dd-20d801e4c9af', churnedAt: '2026-09-24', caseId: 'ea286f78-ca94-43aa-ae43-08486bc0c52f', caseReason: 'price', to: 'price' },
  { id: '498cdce3-3480-49be-a0a0-7a07a96d876d', episode: '0a071f2c-f036-4ccb-8282-3e5795b56a8c', churnedAt: '2026-11-17', caseId: '776041db-0eb2-4164-80ad-47eaa9fe97ef', caseReason: 'competitor', to: 'competitor' },
]);

async function ready(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return false;
  if (!(await knex.schema.hasColumn('customers', 'churn_reason_code'))) return false;
  return knex.schema.hasColumn('customers', 'churn_episode_id');
}

async function writeAudit(knex, action, row, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: 'customers', resource_id: row.id,
    metadata: { migration: MIGRATION, churn_episode_id: row.episode, case_id: row.caseId, case_reason_code: row.caseReason, ...metadata },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await ready(knex))) {
    console.log(`${LOG} column or audit_log missing; nothing to do`);
    return;
  }
  let changed = 0;
  for (const row of ROWS) {
    const n = await knex('customers')
      .where({ id: row.id, churn_episode_id: row.episode, churned_at: row.churnedAt, pipeline_stage: 'churned', churn_reason_code: FROM })
      .update({ churn_reason_code: row.to, updated_at: knex.fn.now() });
    if (!n) continue; // not this database, or no longer that churn
    await writeAudit(knex, ACTION, row, { from: FROM, to: row.to });
    changed += 1;
  }
  console.log(`${LOG} ${changed} of ${ROWS.length} customer(s) coded`);
};

// True while up() wrote this row and no rollback has reversed it yet.
async function writtenByUp(knex, row) {
  const ups = await knex('audit_log').where({ action: ACTION, resource_id: row.id }).select('id');
  const rollbacks = await knex('audit_log').where({ action: ROLLBACK_ACTION, resource_id: row.id }).select('id');
  return ups.length > rollbacks.length;
}

exports.down = async function down(knex) {
  if (!(await ready(knex))) return;
  let restored = 0;
  for (const row of ROWS) {
    if (!(await writtenByUp(knex, row))) continue;
    const n = await knex('customers')
      .where({ id: row.id, churn_episode_id: row.episode, churn_reason_code: row.to })
      .update({ churn_reason_code: FROM, updated_at: knex.fn.now() });
    // Closes up()'s write either way; a corrected row keeps its code.
    await writeAudit(knex, ROLLBACK_ACTION, row, n ? { from: row.to, to: FROM } : { skipped: 'changed since up' });
    if (n) restored += 1;
  }
  console.log(`${LOG} down: ${restored} customer(s) restored`);
};

exports.ROWS = ROWS;
exports.ACTION = ACTION;
