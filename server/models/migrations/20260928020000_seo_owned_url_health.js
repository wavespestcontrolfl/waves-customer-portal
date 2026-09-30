/**
 * seo_owned_url_health — daily content-aware health check for owned URLs
 * that AI answer engines cited in seo_llm_mentions.waves_cited_urls over the
 * trailing 30 days (owner finding 2026-09-27: bradentonflpestcontrol.com/
 * pest-control-costs/ was cited 39x/30d while silently 301->404).
 *
 * One row per (url, checked_on) — the daily sweep upserts in place so a
 * re-run the same ET day never duplicates history. `verdict` is one of ok /
 * redirect_ok / soft_404 / not_found / server_error / challenge / noindex /
 * canonical_elsewhere / fetch_blocked (see server/services/seo/
 * owned-url-health.js). `detail` carries the redirect-hop chain, extracted
 * title/canonical, and any block/error reason for audit.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('seo_owned_url_health', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('url').notNullable();
    t.date('checked_on').notNullable();
    t.text('http_status');
    t.text('final_url');
    t.text('verdict').notNullable();
    t.jsonb('detail');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['url', 'checked_on']);
  });
  await knex.schema.alterTable('seo_owned_url_health', (t) => {
    t.index(['checked_on'], 'seo_owned_url_health_checked_on_idx');
    t.index(['verdict'], 'seo_owned_url_health_verdict_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('seo_owned_url_health');
};
