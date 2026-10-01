/**
 * Backlink Manager v2 — widen `source` with `ai_citation` (the AEO weekly
 * discovery feeder, docs: server/services/seo/ai-citation-classifier.js /
 * link-registry-ai-citation-ingest.js).
 *
 * Additive and reversible. Swaps the CHECK on the two provenance columns
 * (seo_link_domains.source, seo_link_domain_sources.source) that step 1
 * (20260828000040_backlink_registry_step1.js) created — never edits that
 * migration in place (frozen once pushed). No other schema change: this
 * source carries no new authority semantics of its own — the owner-queue
 * safety guard (a domain whose first touch is `ai_citation` never reads
 * AUTO_FREE / AUTO_ACCOUNT) lives entirely in application code
 * (link-authority-policy.js decideAuthority + link-execution-authority.js
 * authorize()), not in the schema.
 *
 * Enum literal is a FROZEN copy of services/seo/link-registry.js LINK_SOURCES
 * — server/tests/link-source-ai-citation-migration.test.js pins it equal. A
 * later change to this enum is a NEW migration that swaps the CHECK again,
 * never an edit here.
 */

const LINK_SOURCES_STEP1 = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown'];
const LINK_SOURCES = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown', 'ai_citation'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr) => `${col} IN (${quoted(arr)})`;

const DOMAINS_CHECK = 'seo_link_domains_source_check';
const DOMAIN_SOURCES_CHECK = 'seo_link_domain_sources_source_check';

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS ${DOMAINS_CHECK}`);
  await knex.raw(check('seo_link_domains', DOMAINS_CHECK, inSet('source', LINK_SOURCES)));
  await knex.raw(`ALTER TABLE seo_link_domain_sources DROP CONSTRAINT IF EXISTS ${DOMAIN_SOURCES_CHECK}`);
  await knex.raw(check('seo_link_domain_sources', DOMAIN_SOURCES_CHECK, inSet('source', LINK_SOURCES)));
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS ${DOMAINS_CHECK}`);
  await knex.raw(check('seo_link_domains', DOMAINS_CHECK, inSet('source', LINK_SOURCES_STEP1)));
  await knex.raw(`ALTER TABLE seo_link_domain_sources DROP CONSTRAINT IF EXISTS ${DOMAIN_SOURCES_CHECK}`);
  await knex.raw(check('seo_link_domain_sources', DOMAIN_SOURCES_CHECK, inSet('source', LINK_SOURCES_STEP1)));
};
