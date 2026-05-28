/**
 * facts-bank-loader.js — reads the structured v2 facts-bank files from the
 * Astro repo (content-ops/facts-bank/) and exposes them to the autonomous
 * content pipeline.
 *
 * The facts-bank is the safety foundation of AI-assisted page optimization:
 * the optimizer may only draft local claims that trace to a verified fact.
 * This loader is the single read path. It:
 *   - resolves the Astro source (filesystem in dev, GitHub on Railway) the
 *     same way content-registry.js does
 *   - parses the YAML frontmatter with js-yaml (the custom frontmatter.js
 *     parser cannot handle the nested fact objects — see SCHEMA.md)
 *   - filters facts to what is safe for a given purpose (prompt vs published
 *     copy), respecting visibility, prompt_use_allowed / public_copy_allowed,
 *     evidence_strength, allowed_contexts, and per-fact TTL
 *
 * It performs NO sufficiency judgement — that is facts-bank-auditor.js. This
 * module only loads, parses, and filters.
 *
 * Schema: content-ops/facts-bank/SCHEMA.md (schema_version 2).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../logger');

const FACTS_BANK_DIR = 'content-ops/facts-bank';
const SUPPORTED_SCHEMA_VERSION = 2;

const ENTITY_DIRS = {
  city: 'cities',
  service: 'services',
  county: 'counties',
};

// Evidence strengths that may appear in published copy. `unverified` and
// anything unrecognized are never usable in copy.
const COPY_SAFE_EVIDENCE = new Set(['verified', 'partially_verified', 'directional']);
const PROMPT_SAFE_EVIDENCE = new Set(['verified', 'partially_verified', 'directional']);

// Contexts a published city/service optimization page may cover. A copy fact
// whose allowed_contexts fall entirely outside this set (e.g. operational
// `route_language`, or any future/unknown context) is excluded from the
// citeable facts_pack AND from claims-ledger validation — so a fact tagged
// only for a non-page context can't be cited and accepted in published copy.
// Defined once and shared by the brief builder, the claims-ledger validator,
// and the sufficiency auditor so the three index the identical citeable set
// and cannot drift. Service-specific topics (lawn_pattern, etc.) are already
// scoped by which service file the pack loads; this only gates cross-context
// leakage. Excludes `route_language` (internal route phrasing, not customer copy).
const PAGE_COPY_CONTEXTS = Object.freeze([
  'service_area',
  'local_examples',
  'pest_pressure',
  'seasonality',
  'home_type',
  'lawn_pattern',
  'treatment_protocol',
  'differentiation',
  'regulation',
]);

// ── source resolution (mirrors content-registry) ───────────────────

function resolveSource(astroSource, astroRoot) {
  const source = String(astroSource || 'auto').trim().toLowerCase();
  if (source === 'auto') {
    return astroRoot && fs.existsSync(astroRoot) ? 'filesystem' : 'github';
  }
  if (['filesystem', 'fs', 'local'].includes(source)) return 'filesystem';
  if (['github', 'gh'].includes(source)) return 'github';
  const err = new Error(`facts-bank-loader: unsupported source "${astroSource}"`);
  err.code = 'INVALID_ASTRO_SOURCE';
  throw err;
}

function entityRelPath(entityType, entityId) {
  const dir = ENTITY_DIRS[entityType];
  if (!dir) throw new Error(`facts-bank-loader: unknown entity_type "${entityType}"`);
  return `${FACTS_BANK_DIR}/${dir}/${entityId}.md`;
}

// ── raw read ────────────────────────────────────────────────────────

async function readRaw({ relPath, source, astroRoot, githubClient, ref }) {
  if (source === 'filesystem') {
    const full = path.join(astroRoot, relPath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, 'utf8');
  }
  // github
  const gh = githubClient || require('./github-client');
  const file = await gh.getFile(relPath, ref);
  return file ? file.content : null;
}

// ── parse ───────────────────────────────────────────────────────────

/**
 * parseFactsFile(raw) → { ok, data, error }
 * Extracts the YAML frontmatter block and parses it with js-yaml.
 */
function parseFactsFile(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'empty file' };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) {
    return { ok: false, error: 'no YAML frontmatter block' };
  }
  let data;
  try {
    data = yaml.load(match[1]);
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${err.message}` };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'frontmatter did not parse to an object' };
  }
  return { ok: true, data };
}

// ── TTL / freshness ─────────────────────────────────────────────────

/**
 * isFactExpired(fact, now) — a fact is expired when it has no last_verified
 * date, or when last_verified + ttl_days is in the past. Facts with no
 * ttl_days default to 180 (conservative — most volatile category default).
 */
function isFactExpired(fact, now = new Date()) {
  if (!fact || !fact.last_verified) return true;
  const verified = new Date(fact.last_verified);
  if (Number.isNaN(verified.getTime())) return true;
  const ttlDays = Number.isFinite(fact.ttl_days) ? fact.ttl_days : 180;
  const expiresAt = new Date(verified.getTime() + ttlDays * 86400000);
  return expiresAt.getTime() < now.getTime();
}

// ── fact filtering ──────────────────────────────────────────────────

/**
 * usableFacts(file, opts) → fact[]
 *
 * Returns the facts safe to use for the given purpose:
 *   - purpose 'prompt' (default): facts the model may SEE. Requires
 *     prompt_use_allowed === true and an acceptable evidence_strength.
 *   - purpose 'copy': facts that may appear in PUBLISHED copy. Requires
 *     public_copy_allowed === true, visibility === 'public', and acceptable
 *     evidence strength.
 *
 * Always excludes expired facts (per-fact TTL). Context gating: pass a single
 * `context` string or a `contexts` array of the contexts the target page/section
 * may cover. A fact passes the gate if it is context-agnostic (no
 * allowed_contexts) OR its allowed_contexts intersect the permitted set. A fact
 * tagged only for contexts outside the permitted set (e.g. operational
 * `route_language`, or any future/unknown context) is excluded — fail-closed.
 */
function usableFacts(file, { purpose = 'prompt', context = null, contexts = null, now = new Date() } = {}) {
  const permitted = Array.isArray(contexts) ? contexts : (context ? [context] : null);
  const facts = Array.isArray(file?.facts) ? file.facts : [];
  return facts.filter((fact) => {
    if (!fact || !fact.id) return false;

    // Visibility / permission flags.
    if (purpose === 'copy') {
      if (fact.public_copy_allowed !== true) return false;
      if (fact.visibility !== 'public') return false;
      if (!COPY_SAFE_EVIDENCE.has(fact.evidence_strength)) return false;
    } else {
      // prompt
      if (fact.prompt_use_allowed !== true) return false;
      if (!PROMPT_SAFE_EVIDENCE.has(fact.evidence_strength)) return false;
    }

    // Freshness.
    if (isFactExpired(fact, now)) return false;

    // Context gating (intersection; agnostic facts pass).
    if (permitted && permitted.length > 0) {
      const ctxs = Array.isArray(fact.allowed_contexts) ? fact.allowed_contexts : [];
      if (ctxs.length > 0 && !ctxs.some((c) => permitted.includes(c))) return false;
    }

    return true;
  });
}

/** Group facts by `type`. */
function factsByType(facts) {
  const out = {};
  for (const fact of facts || []) {
    const t = fact.type || 'unknown';
    (out[t] = out[t] || []).push(fact);
  }
  return out;
}

// ── public load API ─────────────────────────────────────────────────

/**
 * load(entityType, entityId, opts) → file object | null
 *
 * file object: {
 *   ok, entity_type, entity_id, schema_version, facts_bank_status,
 *   generation_allowed, verification_status, last_verified, county,
 *   facts[], allowed_claim_patterns[], disallowed_claim_patterns[],
 *   internal_links{}, rel_path, parse_error?
 * }
 *
 * Returns null when the file does not exist. Returns an object with
 * ok:false + parse_error when the file exists but cannot be parsed (so the
 * auditor can flag it as invalid_schema rather than silently missing).
 */
async function load(entityType, entityId, {
  astroRoot = process.env.ASTRO_REPO_DIR,
  astroSource = process.env.CONTENT_REGISTRY_ASTRO_SOURCE || 'auto',
  githubRef = process.env.CONTENT_REGISTRY_GITHUB_REF
    || process.env.GITHUB_ASTRO_DEFAULT_BRANCH
    || null,
  githubClient = null,
} = {}) {
  const relPath = entityRelPath(entityType, entityId);
  const source = resolveSource(astroSource, astroRoot);

  let raw;
  try {
    raw = await readRaw({ relPath, source, astroRoot, githubClient, ref: githubRef });
  } catch (err) {
    logger.warn(`[facts-bank-loader] read failed for ${relPath}: ${err.message}`);
    return { ok: false, entity_type: entityType, entity_id: entityId, rel_path: relPath, parse_error: `read:${err.message}` };
  }
  if (raw == null) return null;

  const parsed = parseFactsFile(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      entity_type: entityType,
      entity_id: entityId,
      rel_path: relPath,
      parse_error: parsed.error,
    };
  }

  const d = parsed.data;
  return {
    ok: true,
    entity_type: d.entity_type || entityType,
    entity_id: d.entity_id || entityId,
    display_name: d.display_name || null,
    schema_version: d.schema_version || null,
    facts_bank_status: d.facts_bank_status || null,
    generation_allowed: d.generation_allowed === true,
    verification_status: d.verification_status || null,
    last_verified: d.last_verified || null,
    verified_by: d.verified_by || null,
    source_owner: d.source_owner || null,
    county: d.county || null,
    category: d.category || null,
    facts: Array.isArray(d.facts) ? d.facts : [],
    allowed_claim_patterns: Array.isArray(d.allowed_claim_patterns) ? d.allowed_claim_patterns : [],
    disallowed_claim_patterns: Array.isArray(d.disallowed_claim_patterns) ? d.disallowed_claim_patterns : [],
    internal_links: d.internal_links && typeof d.internal_links === 'object' ? d.internal_links : {},
    readiness: d.readiness && typeof d.readiness === 'object' ? d.readiness : null,
    rel_path: relPath,
  };
}

const loadCity = (id, opts) => load('city', id, opts);
const loadService = (id, opts) => load('service', id, opts);
const loadCounty = (id, opts) => load('county', id, opts);

/** List the entity ids present in the facts-bank for a given type. */
async function listEntities(entityType, {
  astroRoot = process.env.ASTRO_REPO_DIR,
  astroSource = process.env.CONTENT_REGISTRY_ASTRO_SOURCE || 'auto',
  githubRef = process.env.CONTENT_REGISTRY_GITHUB_REF
    || process.env.GITHUB_ASTRO_DEFAULT_BRANCH
    || null,
  githubClient = null,
} = {}) {
  const dir = ENTITY_DIRS[entityType];
  if (!dir) throw new Error(`facts-bank-loader: unknown entity_type "${entityType}"`);
  const source = resolveSource(astroSource, astroRoot);
  const relDir = `${FACTS_BANK_DIR}/${dir}`;

  if (source === 'filesystem') {
    const full = path.join(astroRoot, relDir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  }
  const gh = githubClient || require('./github-client');
  const entries = await gh.listDir(relDir, githubRef);
  return (entries || [])
    .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort();
}

module.exports = {
  load,
  loadCity,
  loadService,
  loadCounty,
  listEntities,
  usableFacts,
  factsByType,
  isFactExpired,
  parseFactsFile,
  // constants for the auditor / gate
  SUPPORTED_SCHEMA_VERSION,
  COPY_SAFE_EVIDENCE,
  PAGE_COPY_CONTEXTS,
  ENTITY_DIRS,
  FACTS_BANK_DIR,
};
