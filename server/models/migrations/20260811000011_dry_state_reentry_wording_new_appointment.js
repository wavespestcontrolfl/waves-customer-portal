'use strict';

/**
 * Dry-state re-entry wording on the seeded new_appointment automation step
 * (codex P1 on PR #3360).
 *
 * The 20260424000007 seed told customers to "wait about an hour after
 * interior treatment" / "exterior dries in ~30 minutes" — fixed minute
 * figures that (a) now contradict the 2026-08-11 owner rule making the
 * interior re-entry default 2 hours (and tech-adjustable per visit), and
 * (b) violate the compliance idiom for customer-facing re-entry guidance:
 * never a fixed re-entry/drying minute figure — "once dry" + technician
 * confirms timing (AGENTS.md; same class as 20260714100001).
 *
 * Read-modify-write, admin-edit preserving (same posture as
 * 20260714100001): each body is only rewritten where it still carries the
 * exact seeded sentence — admin-edited copy never matches and is left
 * alone. Sentence-level swap, so an edit elsewhere in the same body does
 * not block the fix. NOT verified against prod rows (no prod access in
 * the authoring sandbox) — the swap is exact-match no-op-safe either way.
 */

const SWAPS = [
  {
    column: 'html_body',
    from: '<p>Wait about an hour after interior treatment before walking barefoot or letting pets back in. For exterior work, you can resume normal activity as soon as the product has dried (usually within 30 minutes).</p>',
    to: '<p>After an interior treatment, keep people and pets off treated surfaces until they are dry — your technician will confirm timing, and your service report includes a countdown showing when rooms are ready. For exterior work, you can resume normal activity as soon as the product has dried.</p>',
  },
  {
    column: 'text_body',
    from: 'After: wait ~1 hour before walking barefoot indoors or letting pets back in; exterior dries in ~30 minutes.',
    to: 'After: keep people and pets off treated indoor surfaces until they are dry — your technician will confirm timing, and your service report counts down when rooms are ready; exterior is back to normal once dry.',
  },
];

async function rewrite(knex, swaps) {
  if (!await knex.schema.hasTable('automation_steps')) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_appointment' })
    .select('id', 'html_body', 'text_body');
  for (const row of rows) {
    const patch = {};
    for (const { column, from, to } of swaps) {
      const body = row[column];
      if (typeof body === 'string' && body.includes(from)) {
        patch[column] = body.split(from).join(to);
      }
    }
    if (Object.keys(patch).length) {
      if (await knex.schema.hasColumn('automation_steps', 'updated_at')) {
        patch.updated_at = new Date();
      }
      await knex('automation_steps').where({ id: row.id }).update(patch);
    }
  }
}

exports.up = async function up(knex) {
  await rewrite(knex, SWAPS);
};

exports.down = async function down(knex) {
  await rewrite(knex, SWAPS.map(({ column, from, to }) => ({ column, from: to, to: from })));
};
