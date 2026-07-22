/**
 * service_completion_attempts.request_hash — widen varchar(64) → varchar(160).
 *
 * The PR #2897 fix-round-10 two-segment request hash (`<core>:<mode>`, two
 * sha256 hex digests joined by ':') is 129 characters, but the column was
 * created as varchar(64) for the original single-segment hash. Every INSERT
 * into service_completion_attempts has thrown
 * "value too long for type character varying(64)" since that deploy, which
 * 500s POST /api/admin/dispatch/:serviceId/complete for ALL service types
 * (lawn, tree & shrub, pest — they share the one completion route).
 *
 * 160 = the 129-char composite plus headroom; bounded rather than text to
 * keep the "this is a fixed-shape hash, not a payload" contract visible in
 * the schema.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_completion_attempts'))) return;
  if (!(await knex.schema.hasColumn('service_completion_attempts', 'request_hash'))) return;
  await knex.schema.alterTable('service_completion_attempts', (t) => {
    t.string('request_hash', 160).alter();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_completion_attempts'))) return;
  if (!(await knex.schema.hasColumn('service_completion_attempts', 'request_hash'))) return;
  // A plain shrink would throw on any stored two-segment hash. Project the
  // composite down to its core segment first — the matchers in
  // completion-attempts.js already treat a separator-free stored hash as
  // core-only (the legacy-row contract), so this stays semantically valid.
  await knex.raw(`
    UPDATE service_completion_attempts
    SET request_hash = split_part(request_hash, ':', 1)
    WHERE request_hash IS NOT NULL AND length(request_hash) > 64
  `);
  await knex.schema.alterTable('service_completion_attempts', (t) => {
    t.string('request_hash', 64).alter();
  });
};
