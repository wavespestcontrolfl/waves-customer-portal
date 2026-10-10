// Round 4 of the herbicide 24-hour hold (Codex round 4 on PR #6243, one P1).
// The four earlier files have run on the Railway preview and stay byte-
// identical (waves-db SKILL §4); this file supersedes the round-2 floor's note.
//
// Round 2 floored the admin-authored rules the follow-up had restored and
// appended the 91-character owner line to each note. An admin note already
// near lawn-watering-rule.js's 500-character label_note limit then came out
// over it, and an over-long note fails validateRule, so resolveWateringRule
// falls back to derivation (null for a dry-form herbicide) and a visit with
// that product loses its whole watering instruction. This file finds every
// rule whose note is over the limit and carries the owner line, trims the
// admin's part to fit (an ellipsis marks the cut) with the owner line kept
// whole, checks the result with validateRule before writing, compare-and-set
// on the value read, one audit row each. Nothing else is touched.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261009183000_watering_rule_herbicide_24h_hold_round4';
const OWNER_LINE = 'Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.';
const MAX_NOTE = 500;
const ELLIPSIS = '…';

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The note trimmed to the limit with the owner line whole, or null when the
// note is within the limit or does not carry the owner line.
function trimmedNote(note) {
  if (typeof note !== 'string' || note.length <= MAX_NOTE || !note.includes(OWNER_LINE)) return null;
  const adminPart = note.replace(OWNER_LINE, '').trim();
  const room = MAX_NOTE - OWNER_LINE.length - 1; // one space before the owner line
  const head = adminPart.length > room ? `${adminPart.slice(0, Math.max(0, room - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}` : adminPart;
  return head ? `${head} ${OWNER_LINE}` : OWNER_LINE;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('products_catalog')
    .whereRaw("length(post_application_watering->>'label_note') > ?", [MAX_NOTE])
    .select('id', 'name', 'post_application_watering');
  for (const row of rows) {
    const before = parseJson(row.post_application_watering);
    const note = before ? trimmedNote(before.label_note) : null;
    if (!note) continue;
    const after = { ...before, label_note: note };
    if (!validateRule(after).valid) continue; // never write a rule the validator rejects
    const updated = await knex('products_catalog')
      .where({ id: row.id })
      .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(before)])
      .update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:note_trimmed`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, before, after },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration never reverts
// on rollback). The audit rows keep every before value.
exports.down = async function down() {};

exports.trimmedNote = trimmedNote;
exports.OWNER_LINE = OWNER_LINE;
exports.MAX_NOTE = MAX_NOTE;
