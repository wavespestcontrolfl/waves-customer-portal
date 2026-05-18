const ESTIMATE_AUTOMATION_PATCHES = [
  {
    automation_key: 'estimate.delivery',
    estimate_status: ['sent', 'viewed'],
    previous_dry_run_notes: 'Counts recent estimates that are still open or sent.',
    dry_run_notes: 'Counts recent sent or viewed estimates that are not closed.',
  },
  {
    automation_key: 'estimate.unviewed_followup',
    estimate_status: ['sent', 'viewed'],
    previous_dry_run_notes: 'Counts recent open estimates where view tracking is not present.',
    dry_run_notes: 'Counts recent sent estimates where view tracking is not present.',
  },
  {
    automation_key: 'estimate.viewed_followup',
    estimate_status: ['sent', 'viewed'],
    previous_dry_run_notes: 'Counts recent open estimates that have a viewed timestamp when available.',
    dry_run_notes: 'Counts recent viewed estimates that have a viewed timestamp when available.',
  },
  {
    automation_key: 'estimate.expiring_notice',
    estimate_status: ['sent', 'viewed'],
    previous_dry_run_notes: 'Counts open estimates with an expiration date in the next two days when that column exists.',
    dry_run_notes: 'Counts sent or viewed estimates with an expiration date in the next two days when that column exists.',
  },
];

const ESTIMATE_AUTOMATION_REVERTS = [
  {
    automation_key: 'estimate.delivery',
    estimate_status: ['sent', 'open'],
    previous_dry_run_notes: 'Counts recent sent or viewed estimates that are not closed.',
    dry_run_notes: 'Counts recent estimates that are still open or sent.',
  },
  {
    automation_key: 'estimate.unviewed_followup',
    estimate_status: ['sent', 'open'],
    previous_dry_run_notes: 'Counts recent sent estimates where view tracking is not present.',
    dry_run_notes: 'Counts recent open estimates where view tracking is not present.',
  },
  {
    automation_key: 'estimate.viewed_followup',
    estimate_status: ['sent', 'open'],
    previous_dry_run_notes: 'Counts recent viewed estimates that have a viewed timestamp when available.',
    dry_run_notes: 'Counts recent open estimates that have a viewed timestamp when available.',
  },
  {
    automation_key: 'estimate.expiring_notice',
    estimate_status: ['sent', 'open'],
    previous_dry_run_notes: 'Counts sent or viewed estimates with an expiration date in the next two days when that column exists.',
    dry_run_notes: 'Counts open estimates with an expiration date in the next two days when that column exists.',
  },
];

async function patchEstimateAutomations(knex, patches) {
  const hasAutomations = await knex.schema.hasTable('email_template_automations');
  if (!hasAutomations) return;

  for (const patch of patches) {
    await knex('email_template_automations')
      .where({ automation_key: patch.automation_key })
      .update({
        conditions: knex.raw(
          "jsonb_set(COALESCE(conditions, '{}'::jsonb), '{estimate_status}', ?::jsonb, true)",
          [JSON.stringify(patch.estimate_status)],
        ),
        dry_run_notes: knex.raw(
          'CASE WHEN dry_run_notes = ? THEN ? ELSE dry_run_notes END',
          [patch.previous_dry_run_notes, patch.dry_run_notes],
        ),
        updated_at: knex.fn.now(),
      });
  }
}

exports.up = async function up(knex) {
  const hasEmailMessages = await knex.schema.hasTable('email_messages');
  if (hasEmailMessages) {
    const hasSuppressionSnapshot = await knex.schema.hasColumn('email_messages', 'suppression_group_key_snapshot');
    if (!hasSuppressionSnapshot) {
      await knex.schema.alterTable('email_messages', (t) => {
        t.string('suppression_group_key_snapshot', 80);
      });
    }

    const hasIdempotencyKey = await knex.schema.hasColumn('email_messages', 'idempotency_key');
    if (hasIdempotencyKey) {
      await knex.raw('ALTER TABLE email_messages ALTER COLUMN idempotency_key TYPE varchar(260)');
    }
  }

  await patchEstimateAutomations(knex, ESTIMATE_AUTOMATION_PATCHES);
};

exports.down = async function down(knex) {
  await patchEstimateAutomations(knex, ESTIMATE_AUTOMATION_REVERTS);

  const hasEmailMessages = await knex.schema.hasTable('email_messages');
  if (!hasEmailMessages) return;

  const hasIdempotencyKey = await knex.schema.hasColumn('email_messages', 'idempotency_key');
  if (hasIdempotencyKey) {
    await knex.raw('ALTER TABLE email_messages ALTER COLUMN idempotency_key TYPE varchar(255)');
  }

  const hasSuppressionSnapshot = await knex.schema.hasColumn('email_messages', 'suppression_group_key_snapshot');
  if (hasSuppressionSnapshot) {
    await knex.schema.alterTable('email_messages', (t) => {
      t.dropColumn('suppression_group_key_snapshot');
    });
  }
};
