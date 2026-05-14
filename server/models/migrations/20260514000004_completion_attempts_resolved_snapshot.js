/**
 * service_completion_attempts — resolved snapshot ownership.
 *
 * When useProtocolDefaults: true, the route resolves products + areas +
 * customer interaction + review routing server-side. The resolved bundle
 * has to be persisted BEFORE service_records is inserted, because the
 * idempotency replay decision happens before that row exists. On retry
 * after a process restart, replay must return the original snapshot —
 * not re-resolve against a possibly-newer protocol_templates active row.
 *
 * The snapshot lives in a sibling column rather than the existing
 * request_hash so that:
 *   - the request hash keeps its narrow meaning (the client-sent body)
 *   - the resolved bundle is auditable on its own
 *   - hash mismatch logic in completion-attempts.js stays untouched
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('service_completion_attempts', (t) => {
    t.jsonb('resolved_completion_snapshot');
    t.string('resolved_completion_snapshot_hash', 80);
    t.string('completion_source', 32);
    t.uuid('protocol_template_id')
      .references('id').inTable('protocol_templates');
    t.string('protocol_template_version', 40);
    t.timestamp('snapshot_written_at');
  });

  await knex.raw(`
    ALTER TABLE service_completion_attempts
    ADD CONSTRAINT service_completion_attempts_completion_source_check
    CHECK (
      completion_source IS NULL OR completion_source IN (
        'one_tap_completion',
        'detailed_form'
      )
    )
  `);

  // Snapshot integrity: a row is either fully pre-resolution (every
  // snapshot/source/template field NULL) or fully post-resolution
  // (snapshot + hash + written_at + completion_source all NOT NULL).
  //
  // The all-NULL branch must include completion_source and the template
  // fields. Without that, a row could carry completion_source='one_tap_
  // completion' + protocol_template_id + protocol_template_version but
  // no snapshot bytes — the one_tap_has_template CHECK would happily
  // approve it, defeating the "snapshot persisted before service_record"
  // invariant that this PR is built on.
  await knex.raw(`
    ALTER TABLE service_completion_attempts
    ADD CONSTRAINT service_completion_attempts_snapshot_coherence
    CHECK (
      (resolved_completion_snapshot IS NULL
        AND resolved_completion_snapshot_hash IS NULL
        AND snapshot_written_at IS NULL
        AND completion_source IS NULL
        AND protocol_template_id IS NULL
        AND protocol_template_version IS NULL)
      OR (resolved_completion_snapshot IS NOT NULL
        AND resolved_completion_snapshot_hash IS NOT NULL
        AND snapshot_written_at IS NOT NULL
        AND completion_source IS NOT NULL)
    )
  `);

  // One-tap submissions are required to reference the protocol template
  // they resolved against. Detailed_form submissions are not.
  await knex.raw(`
    ALTER TABLE service_completion_attempts
    ADD CONSTRAINT service_completion_attempts_one_tap_has_template
    CHECK (
      completion_source IS DISTINCT FROM 'one_tap_completion'
      OR (protocol_template_id IS NOT NULL AND protocol_template_version IS NOT NULL)
    )
  `);
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE service_completion_attempts DROP CONSTRAINT IF EXISTS service_completion_attempts_one_tap_has_template');
  await knex.raw('ALTER TABLE service_completion_attempts DROP CONSTRAINT IF EXISTS service_completion_attempts_snapshot_coherence');
  await knex.raw('ALTER TABLE service_completion_attempts DROP CONSTRAINT IF EXISTS service_completion_attempts_completion_source_check');
  await knex.schema.alterTable('service_completion_attempts', (t) => {
    t.dropColumn('snapshot_written_at');
    t.dropColumn('protocol_template_version');
    t.dropColumn('protocol_template_id');
    t.dropColumn('completion_source');
    t.dropColumn('resolved_completion_snapshot_hash');
    t.dropColumn('resolved_completion_snapshot');
  });
};
