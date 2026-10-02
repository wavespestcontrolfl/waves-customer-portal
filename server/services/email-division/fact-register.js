/**
 * Email division fact register.
 *
 * The facts customer-facing newsletter copy is allowed to state live in
 * fact-register-data.js (code, reviewed like any other change). This module:
 *
 * 1. Syncs that register into knowledge_base (category 'facts', source
 *    'email-division-fact-register') so the admin knowledge base shows the
 *    rows the writer is prompted with — insert what is missing, update a row
 *    only when it still carries exactly what the register last wrote (the
 *    stored fingerprint proves nobody edited it), retire an expired or
 *    withdrawn fact (active=false AND status 'archived', so the shared
 *    knowledge-base search and the admin list drop it too; the status it had
 *    is restored if the fact comes back), and HOLD a row a person has
 *    edited, deleted or deactivated, with an audit row saying so. Status is
 *    otherwise never changed by the sync — not even through the knowledge
 *    base's own "content changed, lift the AI flag" trigger, which the sync
 *    undoes for its rows: a flag is lifted by a person's Verify or an
 *    admin-run flagged-only re-review, never by a wording update. Runs
 *    daily (scheduler.js) and on demand before a draft.
 * 2. Lists the usable facts with their provenance checked: only register
 *    rows the sync stamped, still carrying the register's exact wording,
 *    with a source URL and a quote, active, status 'active' (the weekly
 *    knowledge-base audit hides a doubtful entry by setting status
 *    'flagged'), and not expired. An edited row is shown in the knowledge
 *    base and reported, but never fed to a writer as a verified fact.
 * 3. Flags known-false or overreaching claim shapes so the newsletter
 *    validator can hard-block them before a draft is proofed or sent.
 *
 * The claim rules are a tripwire, not a proof: a false hold costs one proof
 * review, a false pass mails a wrong claim to the list. They work on
 * sentences and clauses, not phrases: a clause that names the pest, the
 * behaviour and the false trigger is the claim, whatever the word order,
 * and the only thing that clears it is a negation attached inside that same
 * clause (never "the sentence contains a negation somewhere": idioms such
 * as "no doubt", "no joke", "never fails to" and "not only" are struck
 * before the negation is looked for, and a negation in a neighbouring
 * clause clears nothing).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');
const { FACTS, SOURCE, VERIFIED_ON } = require('./fact-register-data');

const CATEGORY = 'facts';
const FACT_BY_SLUG = new Map(FACTS.map((fact) => [fact.slug, fact]));
const AUDIT_ACTIONS = {
  seeded: 'knowledge_base.fact_seeded',
  updated: 'knowledge_base.fact_updated',
  retired: 'knowledge_base.fact_retired',
  held: 'knowledge_base.fact_sync_held',
};
// On-demand sync (before a draft) runs at most this often per process; the
// daily cron forces one regardless.
const ENSURE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Fingerprints — the proof a row is untouched.
//
// The register stamps metadata.register_hash with the fingerprint of what it
// wrote (title, quote, content, tags, source URLs). Recomputing the same
// fingerprint from the row's CURRENT values and comparing tells the sync
// whether a person has edited the row since: equal → the register may
// update it; different → hold, never overwrite.
// ---------------------------------------------------------------------------
function fingerprint({ title, quote, content, tags, sourceUrls }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([title, quote, content, tags, sourceUrls]))
    .digest('hex');
}

function factFingerprint(fact) {
  return fingerprint({
    title: fact.title, quote: fact.quote, content: fact.content, tags: fact.tags, sourceUrls: fact.sourceUrls,
  });
}

function rowFingerprint(row) {
  const meta = parseJson(row.metadata, {}) || {};
  return fingerprint({
    title: row.title, quote: row.summary, content: row.content, tags: parseJson(row.tags, []), sourceUrls: meta.source_urls,
  });
}

function isExpired(fact, today) {
  return typeof fact?.expiresOn === 'string' && today >= fact.expiresOn;
}

// The metadata the register manages outside the wording fingerprint. An
// expiry extended (or removed), a derived flag or the verification date
// changing must reach the row even when no word of the fact changed —
// otherwise hasProvenance keeps rejecting the fact at its FORMER deadline.
// A fact checked on another day than the register's default carries its own
// `verifiedOn`.
const verifiedOnFor = (fact) => fact.verifiedOn || VERIFIED_ON;

function managedMetadataCurrent(meta, fact) {
  return (meta.expires_on ?? null) === (fact.expiresOn ?? null)
    && (meta.derived === true) === (fact.derived === true)
    && meta.verified_on === verifiedOnFor(fact)
    && meta.source_url === fact.sourceUrls[0];
}

/**
 * Pure: what the sync does with one register fact given the row currently
 * stored under its slug (or none). Never touches a row a person edited,
 * deactivated or deleted.
 *
 * `priorSeed` says the register seeded this slug before (an audit row
 * exists) — with no row left, a person deleted it, and the register does
 * not put it back.
 *
 * A register row with no register_hash predates fingerprinting (the seed
 * migrations of the first three cuts of this lane, present only in
 * preview/QA databases) — it is the register's own writing, brought under
 * management like an untouched row; a person's edit to one of those cannot
 * be told apart, and the alternative leaves superseded content live in the
 * writer's prompt.
 */
function planFactSync(fact, row, { today, priorSeed = false } = {}) {
  const expired = isExpired(fact, today);
  if (!row) {
    if (expired) return { action: 'skip', reason: 'expired_never_seeded' };
    if (priorSeed) return { action: 'hold', reason: 'deleted_by_person' };
    return { action: 'insert' };
  }
  if (row.source !== SOURCE) return { action: 'hold', reason: 'foreign_row' };

  const meta = parseJson(row.metadata, {}) || {};
  const shippedHash = factFingerprint(fact);
  const legacy = !meta.register_hash;
  const rowHash = rowFingerprint(row);
  // An edit that landed on exactly the register's current wording (the
  // register adopted a person's correction word for word, or the person
  // typed the register's) has converged: restamp it, do not hold it forever.
  const converged = !legacy && rowHash !== meta.register_hash && rowHash === shippedHash;
  // Expired: archive the row (status is what the shared search reads) — a
  // person's edit is kept word for word, but expired guidance leaves the
  // shared search like any other (codex round 6 P2) — and even when a
  // person had already set active=false, that deactivation is remembered
  // so a comeback never switches the row back on.
  if (expired) {
    if (row.status === 'archived') return { action: 'unchanged' };
    return { action: 'retire', reason: 'expired', keepDeactivation: row.active === false && !meta.retired_reason };
  }
  if (!legacy && rowHash !== meta.register_hash && !converged) {
    return { action: 'hold', reason: 'edited_by_person', rowHash, shippedHash };
  }
  // active=false with no retirement stamp is a person's deactivation (the
  // admin knowledge routes write arbitrary columns); the register does not
  // switch it back on — nor after it retired and un-retired the row.
  if (row.active === false && (!meta.retired_reason || meta.deactivated_by_person)) return { action: 'hold', reason: 'deactivated_by_person' };
  const sameWording = converged || (!legacy && meta.register_hash === shippedHash);
  if (sameWording && !converged && row.active && managedMetadataCurrent(meta, fact)) return { action: 'unchanged' };
  return { action: 'update', legacy, reactivate: !row.active, metadataOnly: sameWording, converged };
}

/**
 * Pure: a register row whose slug is no longer in the register. Archived
 * (wording untouched, deactivation remembered), ignored when it is not the
 * register's row at all.
 */
function planStraySync(row) {
  if (!row || row.source !== SOURCE) return { action: 'ignore' };
  if (row.status === 'archived') return { action: 'unchanged' };
  const meta = parseJson(row.metadata, {}) || {};
  // A withdrawn fact archives whatever its state: a person's edit is kept
  // word for word (retirement never touches the wording) but withdrawn
  // guidance leaves the shared search like expired guidance does (codex
  // round 7 P2); a person's active=false is remembered too.
  return { action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: row.active === false && !meta.retired_reason };
}

function rowValues(fact, existingMeta, now) {
  // A row coming back from retirement drops its retirement stamps.
  const {
    retired_on: _retiredOn, retired_reason: _retiredReason, status_before_retire: _statusBefore, ...carried
  } = existingMeta || {};
  const meta = {
    ...carried,
    source_url: fact.sourceUrls[0],
    source_urls: fact.sourceUrls,
    quote: fact.quote,
    verified_on: verifiedOnFor(fact),
    derived: fact.derived === true,
    expires_on: fact.expiresOn || null,
    register_hash: factFingerprint(fact),
  };
  return {
    title: fact.title,
    category: CATEGORY,
    content: fact.content,
    summary: fact.quote,
    tags: JSON.stringify(fact.tags),
    source: SOURCE,
    confidence: 'high',
    metadata: JSON.stringify(meta),
    last_verified_at: new Date(`${verifiedOnFor(fact)}T00:00:00Z`),
    verified_by: SOURCE,
    updated_at: now,
  };
}

async function audit(trx, hasAuditLog, action, row, metadata) {
  if (!hasAuditLog || !row?.id) return;
  await require('../audit-log').recordAuditEvent({
    actor_type: 'system',
    actor_id: null,
    action,
    resource_type: 'knowledge_base',
    resource_id: row.id,
    metadata: { slug: row.slug, source: SOURCE, ...metadata },
    trx,
    critical: true,
  });
}

// One hold audit per (row, reason, shipped content, row content): the daily
// run must not append the same hold every day. A hold with no row (a
// deleted fact) is keyed by slug through resource_id NULL.
async function auditHold(trx, hasAuditLog, row, plan) {
  if (!hasAuditLog) return;
  const query = trx('audit_log').where({ action: AUDIT_ACTIONS.held, resource_type: 'knowledge_base' });
  if (row?.id) query.where({ resource_id: row.id });
  else query.whereNull('resource_id').whereRaw("metadata->>'slug' = ?", [row.slug]);
  const last = await query.orderBy('created_at', 'desc').first();
  const lastMeta = last ? (parseJson(last.metadata, {}) || {}) : null;
  if (lastMeta && lastMeta.reason === plan.reason
    && lastMeta.shipped_hash === (plan.shippedHash || null)
    && lastMeta.row_hash === (plan.rowHash || null)) return;
  await require('../audit-log').recordAuditEvent({
    actor_type: 'system',
    actor_id: null,
    action: AUDIT_ACTIONS.held,
    resource_type: 'knowledge_base',
    resource_id: row?.id || null,
    metadata: {
      slug: row.slug, source: SOURCE, reason: plan.reason,
      shipped_hash: plan.shippedHash || null, row_hash: plan.rowHash || null,
    },
    trx,
    critical: true,
  });
}

// The hybrid knowledge index (knowledge-index/connectors.js loadKb) chunks
// knowledge_base rows into knowledge_embeddings under source 'kb' and
// source_id = slug, and prunes stale chunks only on its own nightly sync.
// A retired fact must leave that index NOW, not up to a day later (codex
// round 9): drop its chunks in the same transaction.
async function dropIndexChunks(trx, hasEmbeddings, slug) {
  if (!hasEmbeddings || !slug) return;
  await trx('knowledge_embeddings').where({ source: 'kb', source_id: slug }).del();
}

async function applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, hasEmbeddings, result }) {
  switch (plan.action) {
    case 'insert': {
      // ON CONFLICT DO NOTHING on any constraint: a concurrent insert of the
      // same slug, or a foreign row already holding this fact's path.
      const inserted = await trx('knowledge_base')
        .insert({
          path: `kb/facts/${fact.slug}.md`,
          slug: fact.slug,
          status: 'active',
          active: true,
          version: 1,
          created_at: now,
          ...rowValues(fact, null, now),
        })
        .onConflict()
        .ignore()
        .returning(['id', 'slug']);
      const created = Array.isArray(inserted) ? inserted[0] : null;
      if (!created?.id) {
        const raced = await trx('knowledge_base').where({ slug: fact.slug }).first('id');
        if (raced) { result.unchanged.push(fact.slug); return; } // lost an insert race: the other writer's row stands
        const held = { action: 'hold', reason: 'insert_conflict' };
        await auditHold(trx, hasAuditLog, { slug: fact.slug }, held);
        result.held.push({ slug: fact.slug, reason: held.reason });
        return;
      }
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.seeded, created, { verified_on: verifiedOnFor(fact) });
      result.inserted.push(fact.slug);
      return;
    }
    case 'update': {
      const meta = parseJson(row.metadata, {}) || {};
      // Coming back from OUR retirement (status still 'archived'): restore
      // the status the row had before — a person's or the audit's flag
      // survives the round trip. Any other status is a person's and is kept.
      const status = (plan.reactivate && row.status === 'archived')
        ? (meta.status_before_retire || 'active')
        : row.status;
      await trx('knowledge_base').where({ id: row.id }).update({
        ...rowValues(fact, meta, now),
        // A person's reclassification of a register fact is theirs to keep:
        // the category is not part of the fingerprint (it is not the
        // fact's wording), so an update must not write 'facts' back over it
        // (codex round 14 P2). Register rows are found by SOURCE.
        category: row.category || CATEGORY,
        active: true,
        status,
        version: (Number(row.version) || 1) + 1,
      });
      // The knowledge base's own trigger (kb_restore_ai_flag_on_content_change)
      // turns an AI-flagged entry back to 'active' when its content changes —
      // "the edit is the fix the flag asked for". Not for register rows: the
      // audit's flag is the audit's to lift, so a corrected fact stays hidden
      // from the writer until a person verifies it or an admin-run
      // flagged-only re-review passes it. Re-assert the intended status in
      // the same transaction (a status-only UPDATE does not fire the trigger).
      if (status !== 'active') {
        await trx('knowledge_base').where({ id: row.id }).whereNot({ status }).update({ status });
      }
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.updated, row, {
        legacy_row: plan.legacy === true,
        reactivated: plan.reactivate === true,
        metadata_only: plan.metadataOnly === true,
        converged: plan.converged === true,
        previous_hash: meta.register_hash || null,
        register_hash: factFingerprint(fact),
      });
      // The hybrid index keeps this fact's chunks until its own nightly
      // sync; a wording change written here (the on-demand sync before a
      // draft after a daytime deploy) must not leave the superseded wording
      // searchable until then (codex round 13 P2) — the retirement branch
      // already drops them. A metadata-only restamp changes no indexed text.
      if (!plan.metadataOnly) await dropIndexChunks(trx, hasEmbeddings, row.slug);
      result.updated.push(fact.slug);
      return;
    }
    case 'retire': {
      // active=false alone is not enough: KnowledgeBase.search() (and so the
      // assistant) and the admin list read status, not active. 'archived' is
      // the knowledge base's own retired state; the prior status is kept in
      // metadata so a comeback restores it.
      const meta = parseJson(row.metadata, {}) || {};
      await trx('knowledge_base').where({ id: row.id }).update({
        active: false,
        status: 'archived',
        updated_at: now,
        metadata: JSON.stringify({
          ...meta,
          retired_on: today,
          retired_reason: plan.reason,
          status_before_retire: row.status,
          ...(plan.keepDeactivation ? { deactivated_by_person: true } : {}),
        }),
      });
      await dropIndexChunks(trx, hasEmbeddings, row.slug);
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.retired, row, {
        reason: plan.reason, status_before_retire: row.status, deactivated_by_person: plan.keepDeactivation === true,
      });
      result.retired.push(row.slug);
      return;
    }
    case 'hold':
      // A person's deactivation also leaves the hybrid index now, not at
      // the next nightly rebuild (the shared readers honor `active`).
      if (plan.reason === 'deactivated_by_person' && row) await dropIndexChunks(trx, hasEmbeddings, row.slug);
      await auditHold(trx, hasAuditLog, row || { slug: fact.slug }, plan);
      result.held.push({ slug: row?.slug || fact.slug, reason: plan.reason });
      return;
    case 'skip':
      result.skipped.push({ slug: fact.slug, reason: plan.reason });
      return;
    default:
      result.unchanged.push(row?.slug || fact.slug);
  }
}

// True when the register seeded this slug before (so a missing row is a
// person's deletion, not a fact that never landed).
async function seededBefore(trx, hasAuditLog, slug) {
  if (!hasAuditLog) return false;
  const prior = await trx('audit_log')
    .where({ action: AUDIT_ACTIONS.seeded, resource_type: 'knowledge_base' })
    .whereRaw("metadata->>'slug' = ?", [slug])
    .first('id');
  return !!prior;
}

/**
 * Sync the code register into knowledge_base. Each fact is its own
 * transaction with the row locked, so a concurrent run (two instances, or
 * the cron beside an on-demand ensure) cannot double-write; an insert race
 * is absorbed by ON CONFLICT DO NOTHING. A row a person edited, deleted or
 * deactivated is never overwritten — it is reported in `held` and audited
 * once per state. Errors on one fact never stop the others.
 */
async function syncFactRegister({ conn = db, now = new Date(), facts = FACTS, retireStrays = true } = {}) {
  const result = { inserted: [], updated: [], retired: [], held: [], unchanged: [], skipped: [], errors: [] };
  if (!(await conn.schema.hasTable('knowledge_base'))) {
    result.skipped.push({ slug: null, reason: 'knowledge_base table missing' });
    return result;
  }
  const hasAuditLog = await conn.schema.hasTable('audit_log');
  const hasEmbeddings = await conn.schema.hasTable('knowledge_embeddings');
  const today = etDateString(now);

  for (const fact of facts) {
    try {
      await conn.transaction(async (trx) => {
        const row = await trx('knowledge_base').where({ slug: fact.slug }).forUpdate().first();
        const priorSeed = row ? false : await seededBefore(trx, hasAuditLog, fact.slug);
        const plan = planFactSync(fact, row, { today, priorSeed });
        await applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, hasEmbeddings, result });
      });
    } catch (err) {
      result.errors.push({ slug: fact.slug, error: err.message });
      logger.warn(`[fact-register] sync failed for ${fact.slug}: ${err.message}`);
    }
  }

  if (retireStrays) {
    // Strays are the register's rows by SOURCE, whatever their category: a
    // person may re-file a fact in the admin knowledge editor, and a fact
    // withdrawn after that still has to retire (codex round 11 P2). The
    // retirement keeps the person's category and wording.
    const strays = await conn('knowledge_base')
      .where({ source: SOURCE })
      .whereNot({ status: 'archived' })
      .whereNotIn('slug', facts.map((fact) => fact.slug))
      .select('id', 'slug');
    for (const stray of strays) {
      try {
        await conn.transaction(async (trx) => {
          const row = await trx('knowledge_base').where({ id: stray.id }).forUpdate().first();
          const plan = planStraySync(row);
          if (plan.action === 'ignore') return;
          await applyFactPlan(trx, { slug: row.slug }, row, plan, { now, today, hasAuditLog, hasEmbeddings, result });
        });
      } catch (err) {
        result.errors.push({ slug: stray.slug, error: err.message });
        logger.warn(`[fact-register] stray sync failed for ${stray.slug}: ${err.message}`);
      }
    }
  }

  return result;
}

let lastEnsureAt = null;

/**
 * Sync unless this process synced within ENSURE_INTERVAL_MS (or `force`).
 * The stamp is set only after a run with NO per-fact error (a thrown failure
 * or a result carrying `errors` leaves it unset), so a transient database
 * failure on one fact is retried on the very next call — the next draft or
 * the next cron tick — instead of waiting out the interval with that fact
 * missing or superseded.
 */
async function ensureFactRegister({ now = new Date(), force = false, sync = syncFactRegister } = {}) {
  if (!force && lastEnsureAt && (now.getTime() - lastEnsureAt) < ENSURE_INTERVAL_MS) {
    return { skipped: true, reason: 'recently synced' };
  }
  const result = await sync({ now });
  if (Array.isArray(result?.errors) && result.errors.length === 0) lastEnsureAt = now.getTime();
  return result;
}

// ---------------------------------------------------------------------------
// Reading facts
// ---------------------------------------------------------------------------

/**
 * True when a knowledge_base row is one of THIS register's facts with its
 * provenance intact: a register slug, the register's source, the register's
 * own fingerprint stamp (metadata.register_hash — what proves the row was
 * written by the sync, never a hand-made row in the same category), the
 * register's EXACT current wording (a row a person edited, or that another
 * writer appended to, is not the verified fact any more — it stays in the
 * knowledge base and is reported held, but never reaches a writer), a
 * source URL and a quote on file, and not past its expiry.
 *
 * verified_by / last_verified_at are deliberately NOT provenance: the weekly
 * knowledge-base audit stamps verified_by on every entry it passes and a
 * person's verification does the same, so reading them here would drop a
 * fact the moment the audit confirmed it.
 */
function hasProvenance(row, today) {
  if (!row || !FACT_BY_SLUG.has(row.slug)) return false;
  if (row.source !== SOURCE) return false;
  const meta = parseJson(row.metadata, {}) || {};
  if (typeof meta.register_hash !== 'string' || !meta.register_hash) return false;
  if (typeof meta.source_url !== 'string' || !/^https:\/\//i.test(meta.source_url)) return false;
  if (typeof row.summary !== 'string' || !row.summary.trim()) return false;
  if (typeof meta.expires_on === 'string' && today >= meta.expires_on) return false;
  const fact = FACT_BY_SLUG.get(row.slug);
  if (isExpired(fact, today)) return false;
  if (rowFingerprint(row) !== factFingerprint(fact)) return false;
  return true;
}

/**
 * List the facts a writer may use, optionally filtered to any of the given
 * tags. `tags` may be a single string or an array; omitted/empty returns
 * every usable fact (bounded by `limit`).
 *
 * Usable means: the register's own row (source + fingerprint stamp), active
 * AND status 'active', with provenance (see hasProvenance). The weekly
 * knowledge-base audit hides an entry it doubts by setting status 'flagged'
 * and leaves `active` alone, so filtering on `active` only would feed a
 * flagged or archived fact straight into a customer-facing prompt.
 */
async function listFacts({ tags, limit = 50, now = new Date() } = {}) {
  const rows = await db('knowledge_base')
    .where({ source: SOURCE, active: true, status: 'active' })
    .orderBy('title', 'asc');

  const today = etDateString(now);
  // newsletter: false facts are knowledge-base only (see fact-register-data.js).
  const usable = rows.filter((row) => hasProvenance(row, today) && FACT_BY_SLUG.get(row.slug).newsletter !== false);
  const wanted = Array.isArray(tags) ? tags : (tags ? [tags] : null);
  const filtered = (wanted && wanted.length)
    ? usable.filter((r) => {
      const rowTags = parseJson(r.tags, []);
      return Array.isArray(rowTags) && rowTags.some((t) => wanted.includes(t));
    })
    : usable;

  return filtered.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Known-false / overreaching claim shapes — a sentence-and-clause tripwire
// ---------------------------------------------------------------------------

// Sentence ends: . ! ? followed by whitespace — except after an abbreviation
// ("St. Augustinegrass", "a.m.", "spp."), whose period is protected first.
const ABBREVIATION = /\b(?:St|Dr|Mr|Mrs|Ms|Jr|Sr|vs|etc|spp|sp|No|Inc|Co|Ave|Blvd|Rd|Ft|Mt|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|U\.S|a\.m|p\.m|e\.g|i\.e)\./gi;
const PROTECTED_DOT = '\u0001';

function normaliseText(text) {
  return String(text ?? '')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

// A single capital initial before a lowercase word is an abbreviated
// binomial ("R. flavipes", "C. formosanus"), never a sentence end: a new
// sentence starts with a capital (codex round 19).
const BINOMIAL_INITIAL = /\b([A-Z])\.(?=\s?[a-z])/g;

function splitSentences(text) {
  const shielded = text
    .replace(ABBREVIATION, (abbr) => abbr.slice(0, -1) + PROTECTED_DOT)
    .replace(BINOMIAL_INITIAL, `$1${PROTECTED_DOT}`);
  return shielded
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(new RegExp(PROTECTED_DOT, 'g'), '.').trim())
    .filter(Boolean);
}

// Clause breaks: punctuation, brackets, a spaced hyphen, and the
// conjunctions that start a new statement. Splitting more than English
// strictly needs only ever makes the tripwire stricter (a claim clause must
// carry its own negation), never looser.
const CLAUSE_BREAK = /\s*(?:[,;:—–!?]|\s-\s|[()[\]]|\b(?:but|yet|and|so|however|though|although|while|whereas|then|because|since|unless|except)\b)\s*/i;

function splitClauses(sentence) {
  return sentence.replace(/[.!?]+\s*$/, '').split(CLAUSE_BREAK).map((clause) => clause.trim()).filter(Boolean);
}

// Negations that clear a claim clause — after the idioms that merely
// contain a negation word are struck out.
const NEGATION_IDIOMS = /\b(?:no\s+doubt|no\s+question|no\s+wonder|no\s+joke|not\s+only|not\s+just|never\s+fails?\s+to|no\s+second-?guessing|no\s+matter|not\s+to\s+mention|no\s+surprise|not\s+least)\b/gi;
const NEGATION = /\b(?:no|not|never|nor|don't|doesn't|didn't|won't|wouldn't|cannot|can't|couldn't|isn't|aren't|wasn't|weren't|hasn't|haven't|without|unrelated|independent|nothing\s+to\s+do|myth|misconception|misunderstanding|folklore|old\s+wives'?\s+tales?|false|untrue|wrong)\b/i;
// "It's a myth that termites DON'T swarm again" asserts the claim.
const MYTH_THAT_NEGATED = /\bmyth\s+that\b[^]*?\b(?:no|not|never|don't|doesn't|won't|cannot|can't)\b/i;
// A bare "Myth" label as the clause before the claim ("Myth: ...",
// "Myth — ...") names the claim false. "Fact or myth" and "Not a myth" do
// not.
const BARE_MYTH_LABEL = /^\s*(?:the\s+)?myth(?:-?busters?)?\s*$/i;

function clauseDenies(clause, extraNegation) {
  const struck = clause.replace(NEGATION_IDIOMS, ' ');
  if (MYTH_THAT_NEGATED.test(struck)) return false;
  if (NEGATION.test(struck)) return true;
  return !!(extraNegation && extraNegation.test(struck));
}

function previousClauseIsMythLabel(clauses, index) {
  return index > 0 && BARE_MYTH_LABEL.test(clauses[index - 1]);
}

// --- termite_second_swarm --------------------------------------------------
//
// The September 2026 Pest Insider draft's actual error: native subterranean
// termites do NOT have a second, storm/late-summer triggered swarm
// (fact-no-storm-triggered-second-termite-swarm). A clause is the claim when
// its subject is termites that are not drywood (both drywood species
// correctly document wide, near-any-month flight windows), it has a
// swarming word and a repeat/storm/late-season word. The subject may sit in
// an earlier clause of the sentence ("Termites, which are not picky, have a
// second swarm after storms") or, for a pronoun subject, in the sentence
// before ("... native subterranean termites fly in spring. They swarm again
// after storms.") — the NEAREST termite mention decides, so a contrastive
// "drywood" earlier in the text does not shield the subterranean claim.
// A termite is named by the common word OR by the scientific names the
// register itself supplies (codex round 19 P1): any "-termes" genus, with or
// without its epithet ("Reticulitermes flavipes"), and the abbreviated
// binomial for a termite epithet ("R. flavipes", "C. formosanus") — never a
// bare initial on its own ("R. zeae" is the large-patch fungus). The drywood
// genera and epithets (Kalotermitidae) name drywood termites, like the word
// "drywood" before "termites".
const DRYWOOD_GENERA = '(?:crypto|incisi|kalo|neo)termes';
const DRYWOOD_EPITHETS = '(?:brevis|cavifrons|snyderi|minor|schwarzi)';
const SUBTERRANEAN_EPITHETS = '(?:flavipes|virginicus|hageni|formosanus|gestroi|tibialis)';
const TERMITE_MENTION = new RegExp(
  `\\b((?:[\\w'-]+\\s+){0,3}?)termites?\\b`
  + `|\\b([a-z]+termes(?:\\s+[a-z]+)?|[a-z]\\.\\s?(?:${DRYWOOD_EPITHETS}|${SUBTERRANEAN_EPITHETS}))\\b`,
  'gi',
);
const DRYWOOD_SCIENTIFIC = new RegExp(`^(?:${DRYWOOD_GENERA}\\b|[a-z]\\.\\s?${DRYWOOD_EPITHETS}$)`, 'i');
const PRONOUN_SUBJECT = /\b(?:they|them|these\s+(?:insects|pests|bugs|termites)|the\s+colony|colonies|the\s+swarmers?|swarmers|alates)\b/i;
// A clause that names another pest as its own subject ("..., and fire ants
// swarm again after storms") is about that pest, not the termites named
// earlier (codex round 7 P2).
const CONTRAST_LEAD_IN = /^(?:unlike|like|compared\s+(?:to|with)|rather\s+than|instead\s+of|as\s+with|as\s+opposed\s+to|versus|vs\.?|not)\b/i;
const OTHER_PEST_SUBJECT = /\b(?:fire\s+ants?|ants?|mosquito(?:es|s)?|(?:cock)?roach(?:es)?|palmetto\s+bugs?|spiders?|fleas?|ticks?|rodents?|rats?|mice|wasps?|bees?|hornets?|yellow\s*jackets?|lovebugs?|love\s+bugs?|chinch\s+bugs?|webworms?|no-see-ums?|midges?|gnats?|flies|bed\s*bugs?|silverfish|earwigs?|millipedes?|centipedes?|scorpions?|beetles?|moths?|aphids?|whiteflies|mealybugs?|scale\s+insects?)\b/i;
const SWARM_WORD = /\b(?:swarm\w*|fl(?:y|ies|ew|ying|own)|flights?|take\s+flight|took\s+flight|taking\s+flight|alates?|winged|emerg\w+|come\s+out|coming\s+out|came\s+out)\b/i;
const REPEAT_TRIGGER = /\b(?:second|another|again|repeat\w*|twice|once\s+more|all\s+over\s+again|late[-\s]?summer|summer(?:s|time)?|storms?|hurricanes?|post[-\s]?storms?|tropical|rainy\s+season)\b/i;
// The register gives every native and subterranean species ONE flight
// window inside January–May (R. flavipes January–April, R. virginicus
// February–May, Asian subterranean from March, Formosan from late April)
// plus the December–February R. hageni; only drywood termites fly in the
// fall. A non-drywood termite subject flying in any other month or season —
// "swarm in fall", "take flight in October" — is the same false claim with
// no "second" or "again" in it (codex round 12 P1). A clause saying the
// swarmers are GONE or the season is OVER by then states the fact.
const OUT_OF_SEASON = /\b(?:june|july|august|september|october|november|fall|autumn|late[-\s]?summer|summer(?:s|time)?|hurricane\s+season|rainy\s+season)\b/i;
const SWARM_RECEDES = /\b(?:gone|over|done|ends?|ended|finished|past|behind\s+us|wrap(?:s|ped)?\s+up|wind(?:s|ing)?\s+down|taper(?:s|ed|ing)?(?:\s+off)?|stop(?:s|ped)?|no\s+longer|quiet|dormant)\b/i;

// The kind of termite the last mention in `text` names: 'drywood',
// 'other', or null when no termite is mentioned.
function lastTermiteKind(text) {
  let kind = null;
  for (const match of text.matchAll(TERMITE_MENTION)) {
    kind = (match[2] !== undefined ? DRYWOOD_SCIENTIFIC.test(match[2]) : /\bdrywood\b/i.test(match[1])) ? 'drywood' : 'other';
  }
  return kind;
}

function termiteClaimInSentence(sentence, previousSentence) {
  const clauses = splitClauses(sentence);
  // The subject a clause inherits: its own termite mention, else the one
  // carried from an earlier clause, else — for a pronoun with no termite
  // named yet in this sentence — the previous sentence's last mention. A
  // termite named LATER in the sentence ("..., while drywood termites can
  // fly in fall") never reaches back to shield an earlier pronoun clause.
  let subject = null;
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    const own = lastTermiteKind(clause);
    if (own) subject = own;
    // A contrast lead-in ("Unlike fire ants,", "compared with mosquitoes,")
    // names the OTHER party, not the subject — the next clause's pronoun
    // still means the termites (codex round 8 P1).
    else if (CONTRAST_LEAD_IN.test(clause)) { /* subject unchanged */ }
    else if (OTHER_PEST_SUBJECT.test(clause)) subject = 'other-pest';
    if (subject === null && PRONOUN_SUBJECT.test(clause)) subject = lastTermiteKind(previousSentence);
    if (subject !== 'other') continue;
    if (!SWARM_WORD.test(clause)) continue;
    const repeat = REPEAT_TRIGGER.test(clause);
    const outOfSeason = !repeat && OUT_OF_SEASON.test(clause) && !SWARM_RECEDES.test(clause);
    if (!repeat && !outOfSeason) continue;
    if (clauseDenies(clause) || previousClauseIsMythLabel(clauses, i)) continue;
    return clause;
  }
  return null;
}

// --- large_patch_summer_disease --------------------------------------------
//
// Large patch is "most likely to be observed from November through May when
// temperatures are below 80°F" and "normally not observed in the summer
// months" (fact-large-patch, UF/IFAS LH044). A clause naming large/brown
// patch together with summer or heat, or with a temperature at or past the
// 80°F line in any wording, is the claim; UF's own "occurs in warm, humid
// weather" and "below 80°F" are not.
// The register names the large-patch fungus Rhizoctonia solani; the full and
// abbreviated binomial are the same subject (codex round 20 P1). The summer
// Rhizoctonia species (R. zeae, R. oryzae: leaf and sheath spot) are OTHER
// lawn subjects, and the bare genus alone names neither.
const PATCH = /\b(?:(?:brown|large)\s+patch|rhizoctonia\s+solani|r\.\s?solani)\b/i;
// The trigger is the CLASS of the threshold, not the one literal "above 80"
// (codex round 10 P1): (i) the season or heat itself; (ii) any upward
// comparator ("exceeds", "more than", "tops", "climbs to", "north of")
// before a figure from 80 to 129, in digits or words, that is not a count
// of something else ("over 80 lawns"); (iii) "the (upper/high/mid) 80s /
// 90s / eighties / nineties / triple digits"; (iv) a figure of 80+ given
// in degrees ("at 85°F", "in 90-degree weather"). A downward comparator
// ("below 80°F", "under 85", "cooler than 90") is never a trigger.
const HOT_FIGURE = '(?:(?:8|9)\\d|1[0-2]\\d)(?:\\.\\d+)?(?!\\d|,\\d{3}|\\.\\d)(?:\'?s)?|(?:eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|(?:one|a)\\s+hundred';
const UPWARD_COMPARATOR = '(?:above|over|past|beyond|exceed(?:s|ed|ing)?|(?:more|greater|higher|warmer|hotter)\\s+than|upwards\\s+of|in\\s+excess\\s+of|north\\s+of|at\\s+least|top(?:s|ped|ping)?|reach(?:es|ed|ing)?|hit(?:s|ting)?|(?:climb(?:s|ed|ing)?|ris(?:e|es|ing|en)|rose|go(?:es|ing)?|went|push(?:es|ed|ing)?|soar(?:s|ed|ing)?|stay(?:s|ed|ing)?|remain(?:s|ed|ing)?|get(?:s|ting)?|got)\\s+(?:up\\s+)?(?:to|past|above|over|into|beyond|at))';
const NOT_A_TEMPERATURE = '(?!\\s*(?:%|percent|per\\s*cent|square|sq\\b|acres?|feet|foot|ft\\b|yards?|miles?|pounds?|lbs?|years?|days?|weeks?|months?|hours?|minutes?|dollars?|homes?|houses?|lawns?|yards?|customers?|people|samples?|species|cases?|times?|calls?|visits?|inch(?:es)?|cm|centimet(?:er|re)s?|met(?:er|re)s?|mm))';
// A temperature unit: 85°F, 85°, 85 degrees, 85-degree, 85 degrees Fahrenheit,
// 85 Fahrenheit.
const TEMP_UNIT = '(?:\\s*°\\s*[FC]?(?![A-Za-z])|-?\\s*degrees?(?:\\s+(?:fahrenheit|celsius|centigrade))?\\b|\\s*(?:fahrenheit|celsius|centigrade)\\b)';
// A degree figure followed by a geometry noun is an angle, not a temperature:
// "a 90-degree arc around a sprinkler head", "at a 90° angle" (codex #5414
// round 3). Only the bare-unit trigger needs this; a folded range or bound
// ("between 85 and 95 degrees") already carries temperature context.
const NOT_AN_ANGLE = '(?!\\s*(?:arcs?|angles?|turns?|rotations?|bends?|corners?|elbows?|sweeps?|curves?|slopes?|pitch|of\\s+(?:arc|rotation|sweep|turn))\\b)';
const TEMP_TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const TEMP_UNITS_WORD = 'one|two|three|four|five|six|seven|eight|nine';
const TEMP_NUM = `(?<![\\d.,])(?:\\d{1,3}(?:\\.\\d+)?(?!\\d|,\\d{3}|\\.\\d)|(?:${TEMP_TENS})(?:[-\\s](?:${TEMP_UNITS_WORD}))?(?![a-z])|(?:one|a)\\s+hundred)`;
const TENS_VALUE = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_VALUE = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
function tempValue(text) {
  const word = String(text).toLowerCase().trim();
  if (/^\d+(?:\.\d+)?$/.test(word)) return parseFloat(word); // "85.5", "26.7"
  if (/hundred$/.test(word)) return 100;
  const [tens, unit] = word.split(/[-\s]+/);
  return (TENS_VALUE[tens] || 0) + (UNIT_VALUE[unit] || 0);
}
const isHotValue = (n) => n >= 80 && n <= 129;
// The 80-degree line is Fahrenheit. A Celsius figure is converted before it
// is judged, so "thrives at 30°C" (86°F) is the claim and "20°C" is not
// (codex #5414 round 4).
const CELSIUS_UNIT = '(?:\\s*°\\s*C(?![A-Za-z])|-?\\s*degrees?\\s+(?:celsius|centigrade)\\b|\\s*(?:celsius|centigrade)\\b)';
const IS_CELSIUS = /°\s*C(?![A-Za-z])|celsius|centigrade/i;
const toFahrenheit = (celsius) => (celsius * 9) / 5 + 32;
const tempValueF = (text, ...units) => (units.some((u) => u && IS_CELSIUS.test(u)) ? toFahrenheit(tempValue(text)) : tempValue(text));

// Temperatures are judged at SENTENCE level, once, BEFORE the sentence is
// split into clauses (codex #5187 follow-up, rounds 1-2): the splitter breaks
// on "and" and on dashes, which cut "80°F and below" and "85 to 95 degrees"
// in half, and every shape the clause regex had to list (copula, adverb,
// spelled-out unit) was one more way to slip. Each temperature phrase that
// carries its direction is replaced by ONE token — hottemp<n> (the figure,
// or the low end of a range, is 80-129 on the hot side) or cooltemp<n>
// (anything else) — and put back in the clause that is reported. The
// PATCH_TRIGGER only reads the hot token and a bare figure with a unit.
//   range        "85 to 95 degrees", "between 85 and 95°F", "85–95°F" -> the LOW end decides
//   trailing     "80°F or higher", "85 and up" (hot) / "80°F and below" (cool)
//   leading down "below 80°F", "under 85 degrees", "cooler than 90"    (cool)
const TEMP_RANGE = new RegExp(`(?:\\b(?:between|from)\\s+)?(${TEMP_NUM})(${TEMP_UNIT})?\\s*(?:\\b(?:to|through|thru|until|and)\\b|[-–—])\\s*(${TEMP_NUM})(${TEMP_UNIT})?`, 'gi');
const TEMP_TRAILING = new RegExp(`(${TEMP_NUM})(${TEMP_UNIT})?\\s*\\b(?:or|and)\\s+(?:(?:a\\s+)?(?:bit|little)\\s+)?(up(?:wards?)?(?!\\s+to\\b)|higher|hotter|warmer|above|more|greater|over|lower|below|less|under|cooler|colder|down(?:wards?)?)\\b${NOT_A_TEMPERATURE}`, 'gi');
// One shared list of phrases that CAP the temperature (the figure that follows
// is a ceiling, so the claim is about the cool side): comparators ("below",
// "no higher than", "not above", "doesn't exceed"), ceilings ("a maximum of",
// "max temperature of", "a ceiling of", "capped at", "tops out at") and "at
// most" / "up to", and the compound forms "less than or equal to" / "at or
// below" / "equal to or lower than" (codex #5414 round 3). A phrase that merely NAMES a figure ("peaks at 90°F", "a
// minimum of 85°F", "a high of 90°F") is not here: the lawn is active AT the
// peak, so those stay hot through the bare temperature-unit trigger. "a high
// of 80°F or less" is cool through the trailing "or less" fold.
const DOWNWARD_BOUND = '(?:at\\s+or\\s+(?:below|under|beneath)|below|under|beneath|(?:less|lower|cooler|colder)\\s+than(?:\\s+or\\s+equal\\s+to)?|equal\\s+to\\s+or\\s+(?:less|lower|cooler|colder)\\s+than|down\\s+to|drop(?:s|ped|ping)?\\s+(?:to|below)|fall(?:s|ing)?\\s+(?:to|below)|no\\s+(?:more|higher|warmer|hotter|greater)\\s+than|(?:is|are|was|were|be)\\s+not\\s+(?:above|over|past|exceeding|more\\s+than|higher\\s+than|warmer\\s+than|hotter\\s+than)|not\\s+(?:above|over|exceeding|to\\s+exceed)|(?:never|\\w+n[\'\u2019]t)\\s+(?:(?:go|get|rise|climb|reach|exceed)(?:es|s)?\\s+(?:above|over|past|beyond)|exceed(?:s|ing)?)|at\\s+most|up\\s+to|(?:a\\s+)?max(?:imum)?(?:\\s+(?:air|soil|daytime|daily|high))?(?:\\s+temp(?:erature)?s?)?\\s+(?:of|is|are)|(?:a|an|the)\\s+(?:upper\\s+)?(?:ceiling|cap|limit)\\s+of|cap(?:s|ped|ping)?\\s+(?:out\\s+)?at|(?:top(?:s|ped|ping)?|max(?:es|ed|ing)?)\\s+out\\s+at)';
const TEMP_LEADING_DOWN = new RegExp(`\\b${DOWNWARD_BOUND}\\s+(?:the\\s+|(?:about|around|roughly|approximately|near|nearly)\\s+)?(?:${TEMP_NUM})(?:${TEMP_UNIT})?`, 'gi');
// A ceiling named AFTER the figure, closing its clause: "80°F max", "80
// degrees maximum", "80°F at most", "an 80°F maximum temperature" — the
// same cap as "a maximum of 80°F".
// It must end the clause: "90°F maximum damage" is not a ceiling.
const TEMP_POSTFIX_CEILING = new RegExp(`(${TEMP_NUM})(${TEMP_UNIT})\\s*,?\\s*(?:max(?:imum)?(?:\\s+(?:air|soil|daytime|daily|high))?(?:\\s+temp(?:erature)?s?)?|at\\s+(?:the\\s+)?most|tops)\\b(?=\\s*(?:[.,;:!?)]|$|and\\b|or\\b|but\\b))`, 'gi');
// Temperature wording earlier in the same clause: "highs are 85 or more",
// "temperatures are expected to be about 85 or higher". "it is estimated
// that large patch damaged 85 or more properties" has none (codex #5561
// rounds 1 and 3). The clause starts after the last punctuation or
// conjunction, so "temperatures soar in July, and 85 or more lawns" is a
// count.
const TEMP_CONTEXT_WORD = /\b(?:temp(?:erature)?s?|highs?|lows?|readings?|thermometer|mercury|heat\s+index|degrees?)\b|°/i;
const CLAUSE_BREAK_BEFORE = /[,;:.!?()]|\b(?:and|but|while|although|though|whereas|because|since|so)\b/gi;
function temperatureContextBefore(whole, offset) {
  const before = whole.slice(0, offset);
  let start = 0;
  for (const m of before.matchAll(CLAUSE_BREAK_BEFORE)) start = m.index + m[0].length;
  return TEMP_CONTEXT_WORD.test(before.slice(start));
}
const TEMP_BARE_CELSIUS = new RegExp(`(${TEMP_NUM})${CELSIUS_UNIT}`, 'gi');
const CEILING_WORD = /\b(?:at\s+most|up\s+to|max(?:imum)?|ceiling|cap(?:s|ped|ping)?|limit|tops?\s+out)\b/i;
const TEMP_FIGURE_WITH_UNIT = new RegExp(`(${TEMP_NUM})(${TEMP_UNIT})?\\s*$`, 'i');
const HOT_DIRECTION = /^(?:up|higher|hotter|warmer|above|more|greater|over)/i;

function foldTemperatures(sentence) {
  const stash = [];
  const token = (kind, original) => {
    stash.push(original);
    return `${kind}${stash.length - 1}`;
  };
  let text = String(sentence).replace(TEMP_RANGE, (match, a, unitA, b, unitB) => {
    if (!unitA && !unitB) return match; // "80 to 90 lawns" is not a temperature
    // Each end is read in its own unit; an end with no unit takes the other's
    // ("29 to 35°C"), so "between 70°F and 30°C" keeps 70°F as its low end.
    const low = Math.min(tempValueF(a, unitA || unitB), tempValueF(b, unitB || unitA));
    return token(isHotValue(low) ? 'hottemp' : 'cooltemp', match);
  });
  text = text.replace(TEMP_TRAILING, (match, figure, unit, direction, offset, whole) => {
    // No unit: "85 or more" is a temperature only when temperature wording
    // leads into it ("temperatures are 85 or higher"). "damaged 85 or more
    // properties" is a count, whatever the noun (codex #5414 round 7).
    if (!unit && !temperatureContextBefore(whole, offset)) return match;
    const hot = HOT_DIRECTION.test(direction) && isHotValue(tempValueF(figure, unit));
    return token(hot ? 'hottemp' : 'cooltemp', match);
  });
  text = text.replace(TEMP_LEADING_DOWN, (match) => {
    // A CEILING above the line ("at most 90°F", "a maximum of 90°F") still
    // names heat the lawn is active in, like the postfix form; a comparator
    // ("below 90°F") keeps the documented cool reading (codex #5561 round 3).
    if (CEILING_WORD.test(match)) {
      const fig = match.match(TEMP_FIGURE_WITH_UNIT);
      if (fig && tempValueF(fig[1], fig[2]) > 80 && isHotValue(tempValueF(fig[1], fig[2]))) return token('hottemp', match);
    }
    return token('cooltemp', match);
  });
  // A ceiling above the line still names heat the lawn is active in:
  // "thrives at a 90°F maximum air temperature" stays hot (codex #5561 round 2).
  text = text.replace(TEMP_POSTFIX_CEILING, (match, figure, unit) => token(tempValueF(figure, unit) > 80 && isHotValue(tempValueF(figure, unit)) ? 'hottemp' : 'cooltemp', match)); // a ceiling AT 80 is the cool side
  // A bare Celsius figure left over ("at 30°C", "above 30 degrees Celsius"):
  // judged on its Fahrenheit value, so the raw-number triggers never see it.
  text = text.replace(TEMP_BARE_CELSIUS, (match, figure) => token(isHotValue(toFahrenheit(tempValue(figure))) ? 'hottemp' : 'cooltemp', match));
  const restore = (clause) => String(clause).replace(/\b(?:hot|cool)temp(\d+)\b/g, (_m, n) => stash[Number(n)] ?? _m);
  return { text, restore };
}

const PATCH_TRIGGER = new RegExp(
  '\\b(?:summer(?:s|time)?|june|july|august|september|rainy\\s+season|hot(?:ter|test)?|heat(?:waves?)?|warm(?:er|est)\\s+months?|dog\\s+days)\\b'
  + `|\\b${UPWARD_COMPARATOR}[-\\s]+(?:the\\s+)?(?:${HOT_FIGURE})${NOT_A_TEMPERATURE}`
  + '|\\bthe\\s+(?:(?:upper|high|mid|low|mid-to-upper)[-\\s]+)?(?:(?:8|9)0\'?s|eighties|nineties|100\'?s|hundreds|triple[-\\s]+digits)\\b'
  // (iv) a figure of 80+ with a temperature unit ANYWHERE in the clause —
  // "at 85°F", "in 90-degree weather", "are 85°F", "are consistently 90
  // degrees or higher" — not only after a preposition or a listed copula:
  // the unit makes it a temperature, so no verb or adverb shape is
  // enumerated. The cool side of the line (a downward comparator, "or
  // lower", a range that starts below 80) was folded away first, see
  // foldTemperatures.
  + `|(?<![\\d.,])\\b(?:${HOT_FIGURE})${TEMP_UNIT}${NOT_AN_ANGLE}`
  // (v) a phrase foldTemperatures judged hot: a range, "or higher" / "and up".
  + '|\\bhottemp\\d+\\b',
  'i',
);
// A clause that says large patch RECEDES in the heat is the fact, not the
// myth: "Large patch slows once temperatures climb above 80°F" (codex round
// 10 P1). The receding verb must come before any activity verb in the
// clause — "Large patch thrives in summer as the grass slows down" is
// still the claim — and must not itself be negated: "Large patch doesn't
// slow down in summer" asserts the claim, whatever a negation elsewhere
// would otherwise clear. "rarely" / "seldom" recede only when they modify
// an activity or uncommon predicate ("rarely a problem", "seldom spreads");
// bare, they are a negation — "rarely absent in summer", "seldom quiet",
// "rarely lets up" assert the claim (codex #5414 round 3 P1), which
// NEGATED_RECEDE catches because absent / quiet / lets up are receding terms.
// The predicate must follow the adverb DIRECTLY: no free words in between,
// so "rarely fails to thrive" (a double negative, the claim) is not read as
// "rarely thrives" (codex #5414 round 5 P1). Unlisted wording is flagged.
const RECEDE_SOURCE = '(?:stop(?:s|ped|ping)?\\s+spreading|slow(?:s|ed|ing)?(?:\\s+down)?|stop(?:s|ped|ping)?|fad(?:e|es|ed|ing)(?:\\s+away|\\s+out)?|subsid(?:e|es|ed|ing)|(?:go(?:es)?|went|going|gone)\\s+(?:dormant|quiet|away)|dorman(?:t|cy)|back(?:s|ed|ing)?\\s+off|eas(?:e|es|ed|ing)(?:\\s+off|\\s+up)?|declin(?:e|es|ed|ing)|wan(?:e|es|ed|ing)|disappear(?:s|ed|ing)?|clear(?:s|ed|ing)?\\s+up|(?:di(?:e|es|ed)|dying)\\s+(?:back|down|out|off)|shut(?:s|ting)?\\s+down|quiet(?:s|ed|ing)?\\s+down|inactive|recover(?:s|ed|ing)?|(?:grow(?:s|ing)?|grew)\\s+out|retreat(?:s|ed|ing)?|diminish(?:es|ed|ing)?|abat(?:e|es|ed|ing)|halt(?:s|ed|ing)?|end(?:s|ed)?|absent|quiet|let(?:s|ting)?\\s+up|rare|uncommon|unlikely|less\\s+(?:common|likely|active|prevalent|severe|of\\s+a\\s+problem)|(?:rarely|seldom|hardly\\s+ever|infrequently)\\s+(?:ever\\s+)?(?:(?:a|an|much\\s+of\\s+a)\\s+)?(?:problem|issue|concern|seen|found|present|noticed|spotted|reported|visible|noticeable|active|thriv\\w*|flar\\w*|spread\\w*|appear\\w*|show(?:s|ed|ing)?\\s+up|develop\\w*|strik\\w*|attack\\w*|damag\\w*|return\\w*|infect\\w*|kill\\w*|surviv\\w*|persist\\w*))';
const RECEDE = new RegExp(`\\b${RECEDE_SOURCE}\\b`, 'i');
const PATCH_ACTIVE = /\b(?:thriv\w*|flar\w*|spread\w*|peak\w*|explod\w*|surg\w*|take[sn]?\s+off|taking\s+off|took\s+off|worst|strik\w*|attack\w*|appear\w*|show(?:s|ed|ing)?\s+up|develop\w*|active|activit\w*|lov(?:e|es|ed|ing)|prefer\w*|favou?r\w*|grow(?:s|ing)?|kick\w*\s+in|ramp\w*\s+up|common|prevalent|rampant|big\w*\s+problem|problem|damag\w*|kill\w*|infect\w*|return\w*|come\w*\s+back|comes)\b/i;
const NEGATED_RECEDE = new RegExp(`\\b(?:not|never|no\\s+longer|hardly|rarely|seldom|cannot|\\w+n't)\\s+(?:\\w+\\s+){0,2}?${RECEDE_SOURCE}\\b(?![^]*\\b(?:until|before)\\b)`, 'i');
// "anything but active" is NOT read as a negation (codex #5561 rounds 1-2):
// every reading of the idiom either let "never anything but active" or
// "thrives in anything but dry summers" pass, so it stays a false block,
// which the proof surfaces to the owner, rather than a false pass.
const MYTH_WORD = /\b(?:myth|misconception|misunderstanding|folklore|old\s+wives'?\s+tales?|false|untrue|wrong)\b/i;

// The clause is the fact that large patch recedes: a receding verb, not
// negated, ahead of any activity verb.
function patchRecedes(clause) {
  const recede = clause.match(RECEDE);
  if (!recede || NEGATED_RECEDE.test(clause)) return false;
  const active = clause.replace(new RegExp(RECEDE.source, 'gi'), (m) => ' '.repeat(m.length)).match(PATCH_ACTIVE);
  return !active || active.index > recede.index;
}
// The contrast must be ABOUT large patch — the words sit directly before
// the patch noun ("mistaken for large patch", "unlike large patch"); a
// contrast elsewhere in the clause ("Large patch thrives in summer unlike
// gray leaf spot") asserts the claim (codex round 8 P1).
const PATCH_CONTRAST = /\b(?:unlike|differs?\s+from|different\s+from|distinct\s+from|confused\s+with|mistaken\s+for|instead\s+of|rather\s+than)\s+(?:a\s+|the\s+)?(?:brown|large)\s+patch\b/i;

// Another lawn problem named as a clause's own subject ("..., gray leaf
// spot is a summer disease") is not large patch.
const OTHER_LAWN_SUBJECT = /\b(?:gray\s+leaf\s+spot|chinch\s+bugs?|chinch\s+damage|dollar\s*weed|dove\s*weed|take-?all(?:\s+root\s+rot)?|root\s+rot|sod\s+webworms?|army\s*worms?|grubs?|mole\s+crickets?|nematodes?|drought|dry\s+spots?|dog\s+spots?|pythium|rhizoctonia\s+leaf|rhizoctonia\s+(?:zeae|oryzae)|r\.\s?(?:zeae|oryzae)|leaf\s+and\s+sheath\s+spot|fairy\s+ring|rust|weeds?)\b/i;

// "Large patch normally appears in spring. It thrives in summer." — the
// pronoun means the disease named in the sentence before (codex round 9).
const LAWN_PRONOUN_SUBJECT = /\b(?:it|this\s+(?:disease|fungus|patch|problem)|the\s+disease|the\s+fungus)\b/i;

// The last lawn subject named in `text`: 'patch', 'other', or null.
function lastLawnSubject(text) {
  let kind = null;
  let at = -1;
  for (const match of text.matchAll(new RegExp(PATCH.source, 'gi'))) {
    if (match.index > at) { at = match.index; kind = 'patch'; }
  }
  for (const match of text.matchAll(new RegExp(OTHER_LAWN_SUBJECT.source, 'gi'))) {
    if (match.index > at) { at = match.index; kind = 'other'; }
  }
  return kind;
}

// A verbless fragment set off by commas — "..., in the summer", "...,
// especially in July", "..., of course, ..." — has no verdict of its own: it
// inherits the verdict of the nearest clause before it that carries a verb,
// judged ALONE. "Large patch is dormant, not active, in the summer" states
// the fact in its first clause; "Large patch thrives, without slowing, in
// summer" asserts the claim there — the "without" in the fragment between
// reinforces the claim, it never clears it (codex round 11 P1), so the
// clauses are never concatenated and handed to the generic negation test.
// A fragment that carries its own negation ("..., not in summer, but in
// fall") is judged alone, like a full clause. A fragment WITH a verb ("in
// the summer it thrives") stands on its own, as before.
const FRAGMENT_LEAD = /^(?:in|into|during|through(?:out)?|over|across|by|until|till|from|for|as|with|without|like|such|since|after|before|around|about|at|on|within|of|come|especially|particularly|mostly|mainly|usually|typically|often|even|only|not|never|rarely|seldom|less|more|much|far|well)\b/i;
const CLAUSE_VERB = /\b(?:is|are|was|were|be|been|being|am|has|have|had|do|does|did|can|could|will|would|should|may|might|must|shall|gets?|got|becomes?|became|stays?|stayed|remains?|remained|keeps?|kept|tends?|seems?|appears?|appeared|looks?|shows?|showed|thrives?|thrived|flares?|flared|spreads?|peaks?|peaked|slows?|slowed|stops?|stopped|fades?|faded|goes|went|gone|comes?|came|hits?|strikes?|struck|develops?|developed|starts?|started|begins?|began|returns?|returned|takes?|took|makes?|made|causes?|caused|means?|meant|needs?|wants?|thinks?|sees?|saw|expect\w*|watch\w*|treat\w*|appl(?:y|ies|ied)|water\w*|mow\w*|hold\w*|skip\w*|wait\w*|call\w*|love\w*|like\w*|prefer\w*)\b/i;
function isFragment(clause) {
  return FRAGMENT_LEAD.test(clause) && !CLAUSE_VERB.test(clause);
}
// The clause whose verdict clause i carries (`judged`), and the text from
// that clause through clause i (`span`) — the span only ever answers "is
// the contrast about large patch" and "does an until/before follow the
// negated receding verb", never the generic negation test.
function patchVerdictUnit(clauses, i) {
  const own = { judged: clauses[i], span: clauses[i] };
  if (!isFragment(clauses[i]) || clauseDenies(clauses[i])) return own;
  let j = i - 1;
  while (j >= 0 && isFragment(clauses[j])) j -= 1;
  if (j < 0) return own;
  return { judged: clauses[j], span: clauses.slice(j, i + 1).join(' ') };
}

function patchClaimInSentence(sentence, previousSentence = '') {
  const folded = foldTemperatures(sentence);
  const clauses = splitClauses(folded.text);
  // The subject carries across clauses the same way it does for termites:
  // "Large patch, rather than chinch damage, is what you see in summer"
  // asserts the claim in its third clause (codex round 8); a leading pronoun
  // takes the previous sentence's lawn subject (codex round 9).
  let subject = null;
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (PATCH.test(clause)) subject = 'patch';
    else if (CONTRAST_LEAD_IN.test(clause)) { /* names the other party, subject unchanged */ }
    else if (OTHER_LAWN_SUBJECT.test(clause)) subject = 'other';
    if (subject === null && LAWN_PRONOUN_SUBJECT.test(clause)) subject = lastLawnSubject(previousSentence);
    if (subject !== 'patch' || !PATCH_TRIGGER.test(clause)) continue;
    if (previousClauseIsMythLabel(clauses, i)) continue;
    // A verbless fragment carries the verdict of the clause it hangs off
    // (see patchVerdictUnit); a full clause is judged on its own.
    const { judged, span } = patchVerdictUnit(clauses, i);
    // "Large patch doesn't slow down in summer": the negation is on the
    // receding verb, so it asserts the claim — unless the clause calls it
    // a myth. "..., until the heat" after it is the fact (receding waits
    // for the heat), the same as within one clause.
    if (NEGATED_RECEDE.test(judged) && !/\b(?:until|before)\b/i.test(span)) {
      if (MYTH_WORD.test(judged)) continue;
      return folded.restore(clause);
    }
    if (patchRecedes(judged) || clauseDenies(judged) || PATCH_CONTRAST.test(span)) continue;
    return folded.restore(clause);
  }
  return null;
}

// --- non_flea_vacuum_advice ------------------------------------------------
//
// Continuing to vacuum after treatment is flea guidance: it stimulates pupae
// to hatch into the treatment (fact-flea-vacuuming-after-treatment,
// University of Kentucky ENTFACT-602). A clause telling the customer to
// vacuum for a fixed time is exempt only when the clause (or a lead-in
// clause before it: "For fleas, ...") is about fleas, the instruction is
// affirmative (never "avoid", "hold off", "wait N days before vacuuming" —
// not for fleas, not for anything) and every duration in it is one the
// source states (a few weeks; 1 to 4 weeks; up to 4 weeks). "Vacuum daily
// for 14 days" is a made-up number even in a flea sentence, and so is "for
// a month" — every unit counts, months and years included, and the sourced
// exemption stays limited to its documented week ranges (codex round 12 P1).
// ONE spelled-number grammar for every duration rule (codex round 20 P1:
// the old allowlists skipped eleven, fifteen, seven minutes, ...): digits,
// one–nineteen, the tens with an optional unit ("twenty-one", "forty five"),
// a hundred, a dozen, and the vague counts (a few, several, a couple, a/an).
const NUMBER_UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const NUMBER_WORD = '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:' + NUMBER_UNITS + '))?'
  + '|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|' + NUMBER_UNITS
  + '|(?:a|one)\\s+hundred|(?:a|one)\\s+dozen|a\\s+few|several|a\\s+couple(?:\\s+of)?|half\\s+an?|an?)';
const VACUUM = /\bvacuum\w*\b/i;
const DURATION = new RegExp(`\\b(?:\\d+|${NUMBER_WORD})\\s*(?:(?:to|or|-|–)\\s*(?:\\d+|${NUMBER_WORD})\\s*)?(?:days?|weeks?|months?|years?|fortnights?)\\b`, 'gi');
const SOURCED_FLEA_DURATION = /\b(?:a\s+few|several)\s+weeks\b|\b(?:1|one)\s*(?:to|-|–)\s*(?:4|four)\s+weeks\b|\b(?:up\s+to\s+)?(?:4|four)\s+weeks\b/gi;
const VACUUM_NEGATION = /\b(?:avoid|hold\s+off|wait|skip|delay|postpone|refrain|stop|before\s+vacuum\w*)\b/i;
const FLEA = /\bfleas?\b/i;
const FLEA_LEAD_IN = /^(?:for|with|after|following|against|during|if|when|once)\b[^]*\bfleas?\b/i;

function vacuumClaimInSentence(sentence) {
  const clauses = splitClauses(sentence);
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (!VACUUM.test(clause) || !new RegExp(DURATION.source, 'i').test(clause)) continue;
    const fleaContext = FLEA.test(clause) || (i > 0 && FLEA_LEAD_IN.test(clauses[i - 1]));
    const affirmative = !clauseDenies(clause, VACUUM_NEGATION);
    const unsourced = new RegExp(DURATION.source, 'i').test(clause.replace(SOURCED_FLEA_DURATION, ' '));
    if (fleaContext && affirmative && !unsourced) continue;
    return clause;
  }
  return null;
}

// --- absolute_safety_claim -------------------------------------------------
//
// AGENTS.md: no pesticide is ever "safe" (incl. "pet-safe"/"family-safe"),
// and the one allowed idiom — "safe once dry" — must come with the
// technician confirming the timing. The repo-wide compliance predicate
// (content-guardrails.js reentrySafetyClaimFinding — the same one comms-lint,
// the voice relay and the lawn customer copy use) is authoritative: whatever
// it flags, this rule flags. The patterns below are the UNION with it, for
// the copula, prepositional and bare-adjective forms it lets through ("It
// is safe for the whole family", "our safe lawn treatment"). The label's
// own wording ("Do not permit humans or pets to contact treated surfaces
// until the spray has dried") is not a safety claim; "safe to say", "a safe
// distance" and "a safe trip" are not product-safety claims either.
// Hyphenated only: "keep your family safe from mosquitoes" is not a claim.
// Any audience "-safe" compound is the claim — pollinator-safe, wildlife-safe,
// fish-safe, not only a fixed list (codex round 20 P1) — except the idiom
// "fail-safe". A negation directly governing the compound ("is not
// pet-safe", "isn't really wildlife-safe") states the opposite and clears it
// (codex round 20 P2); a negation elsewhere in the sentence does not.
const SAFE_COMPOUND = /\b(?!fail-)[a-z]+-safe(?:r|st)?\b/gi;
const COMPOUND_NEGATED_BEFORE = /\b(?:not|never|nor|isn't|aren't|wasn't|weren't|no\s+longer)\s+(?:\w+\s+)?$/i;
function assertedSafeCompound(sentence) {
  for (const match of sentence.matchAll(SAFE_COMPOUND)) {
    if (!COMPOUND_NEGATED_BEFORE.test(sentence.slice(Math.max(0, match.index - 40), match.index))) return true;
  }
  return false;
}
// Copula forms ("is safe"), prepositional forms ("safe for / around / once
// dry"), and the bare adjective on a product or service ("our safe lawn
// treatment", "a safe, effective spray", "the safe choice"). Not: "safe
// from" (protection), "safe to say", "a safe distance / place / bet".
// ONE product vocabulary (codex round 18 P1): the nouns this predicate reads
// as a pesticide product or service are the same nouns TREATMENT_CONTEXT
// (below) reads as treatment talk, so the scope that decides whether the
// safety rule runs can never miss a noun the rule itself recognises.
const PRODUCT_NOUNS = 'treatments?|products?|sprays?|formulas?|formulations?|applications?|options?|choices?|ways?|solutions?|pesticides?|insecticides?|herbicides?|chemicals?|services?|barriers?|alternatives?|approach(?:es)?|methods?|programs?|plans?|ingredients?|materials?';
const SAFE_PRODUCT_NOUN = `(?:lawn|pest|termite|mosquito|rodent|ant|flea|indoor|outdoor|home|yard|residential|commercial)?\\s*(?:${PRODUCT_NOUNS})`;
const SAFE_IDIOM_NOUN = '(?:from|to\\s+say|bet|distance|place|space|side|harbou?r|haven|spot|room|hands|travels?|trip|journey|holiday|weekend|season|drive|passage)';
// "safe", "safer" and "safest" are the same claim; so is "used safely
// around pets" (codex round 7 P1).
const SAFE_WORD = 'safe(?:r|st)?';
const SAFE_CLAIM = new RegExp(
  `\\b(?:is|are|it's|its|be|being|remains?|becomes?|considered|deemed|completely|totally|perfectly|entirely|100%|much|far|even|the)\\s+(?:\\w+\\s+)?${SAFE_WORD}\\b(?!\\s+${SAFE_IDIOM_NOUN}\\b)`
  + `|\\b${SAFE_WORD}\\s+(?:for|around|near|with|once|when|after|as\\s+soon\\s+as|than)\\b`
  + `|\\b${SAFE_WORD}\\s+to\\s+(?!say\\b)\\w+`
  + '|\\bsafely\\s+(?:around|near|with|on|in|indoors|outdoors|inside|outside)\\b'
  + '|\\b(?:used?|appl(?:y|ied)|sprayed|treated?)\\s+safely\\b',
  'i',
);
// The bare adjective on a product noun, tested on the whole sentence: "a
// safe, effective spray" spans the comma a clause split would cut at.
const SAFE_ADJECTIVE_PRODUCT = new RegExp(`\\b${SAFE_WORD}(?:,?\\s+(?:and\\s+)?\\w+)?\\s+${SAFE_PRODUCT_NOUN}\\b`, 'i');
const TECHNICIAN_CONFIRMS = /\btechnicians?\b[^.]{0,80}\b(?:confirm|tell|let\s+you\s+know|advise|say|give)|\b(?:confirm|tell|advise|check)\w*[^.]{0,40}\btechnicians?\b/i;
// The technician idiom exempts ONLY dry-state re-entry guidance: "safe once
// dry / when it has dried, and your technician confirms the timing". It
// never exempts an absolute audience claim ("safe for children and pets")
// or a fixed re-entry time ("safe after 15 minutes"), technician or not.
const DRY_STATE = /\b(?:once|when|after|until)\b[^.,;]{0,40}?\b(?:dry|dried|dries)\b|\b(?:has|have)\s+dried\b|\bdry\s+to\s+the\s+touch\b/i;
// Worded fractions of an hour are the same fixed figure (codex round 11
// P1): "a quarter hour", "a quarter-hour", "a quarter of an hour", "three
// quarters of an hour", "a half hour", "half an hour", "an hour and a half".
const FIXED_REENTRY_TIME = new RegExp(`\\b(?:\\d+|${NUMBER_WORD})\\s*(?:(?:to|or|-|–)\\s*(?:\\d+|${NUMBER_WORD})\\s*)?(?:minutes?|mins?|hours?|hrs?)\\b|`
  + String.raw`\b(?:(?:a|one)\s+)?quarter(?:-|\s+of\s+an?\s+|\s+)hour\b|\bthree[-\s]quarters?\s+of\s+an\s+hour\b|\ba\s+half[-\s]hour\b|\ban?\s+hour\s+and\s+a\s+half\b`, 'i');
// Every protected audience, in every degree ("safer for pets", "safest for
// pollinators"): never inside the dry-state idiom (codex round 8 P1).
// Any degree of "safe" other than the plain adjective (codex round 10 P1).
const SAFE_COMPARATIVE = /\bsafe(?:r|st)\b|\bsafely\b/i;
const AUDIENCE_SOURCE = '(?:the\\s+|your\\s+|our\\s+)?(?:bees?|pollinators?|butterfl(?:y|ies)|birds?|fish|wildlife|pets?|kids?|children|babies|infants?|toddlers?|dogs?|cats?|puppies|kittens?|people|humans?|everyone|everybody|(?:whole\\s+|entire\\s+)?family|the\\s+environment)';
const AUDIENCE_ABSOLUTE = new RegExp(`\\bsafe(?:r|st)?\\s+(?:for|around|near|with)\\s+${AUDIENCE_SOURCE}\\b`, 'i');
// The adjective form names its audience after the product noun: "a safe
// treatment for pets once dry" is the audience claim, idiom or not.
const AUDIENCE_AFTER_PRODUCT = new RegExp(`\\b(?:for|around|near|with)\\s+${AUDIENCE_SOURCE}\\b`, 'i');

// The dry-state + technician exemption is bound to the CLAIM's clause: the
// dry condition and the technician confirmation must sit in that clause or
// the one right beside it. "The treatment is safe and works after it dries;
// your technician confirms timing" is not the idiom — "after it dries"
// modifies "works", and the technician clause is two clauses away.
// The repo-wide predicate's finding, with the phrase it matched (quoted in
// its message) and whether that phrase is a time figure — a duration is the
// fixed_reentry_time rule's to report, a safety word this rule's, so one
// problem is reported once, under the right heading (codex round 8 P2).
const DURATION_WORD = /\b(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?)\b/i;
function canonicalFinding(sentence) {
  const finding = reentrySafetyClaimFinding(sentence);
  if (!finding) return null;
  const phrase = (String(finding.message || '').match(/violation "([^"]*)"/) || [])[1] || '';
  return { phrase, isDuration: DURATION_WORD.test(phrase) };
}

// The bare adjective on a product noun takes the same narrow dry-state
// exemption as the clause forms (codex round 11 P2): "This is a safe
// treatment once dry, and your technician confirms timing" is the idiom.
// Exactly "safe" (never safer/safest), the dry state and the technician in
// the claim's clause or the one beside it, no fixed time and no audience.
function adjectiveInDryStateIdiom(sentence, clauses, match) {
  if (SAFE_COMPARATIVE.test(match[0])) return false;
  const first = splitClauses(`${sentence.slice(0, match.index)}X`).length - 1;
  const last = Math.max(first, splitClauses(sentence.slice(0, match.index + match[0].length)).length - 1);
  const claim = clauses.slice(first, last + 1).join(' ');
  const beside = clauses.slice(Math.max(0, first - 1), last + 2).join(' ');
  return DRY_STATE.test(beside) && TECHNICIAN_CONFIRMS.test(beside)
    && !FIXED_REENTRY_TIME.test(claim) && !AUDIENCE_ABSOLUTE.test(claim) && !AUDIENCE_AFTER_PRODUCT.test(claim);
}

function safetyClaimInSentence(sentence) {
  const canonical = canonicalFinding(sentence);
  if (canonical && !canonical.isDuration) return sentence;
  if (assertedSafeCompound(sentence)) return sentence;
  const clauses = splitClauses(sentence);
  for (const match of sentence.matchAll(new RegExp(SAFE_ADJECTIVE_PRODUCT.source, 'gi'))) {
    if (!adjectiveInDryStateIdiom(sentence, clauses, match)) return sentence;
  }
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (!SAFE_CLAIM.test(clause)) continue;
    const beside = [clauses[i - 1], clause, clauses[i + 1]].filter(Boolean).join(' ');
    // The idiom is exactly "safe" once dry: "safer once dry", "the safest
    // once it dries" and "used safely once dry" are comparative or
    // absolute claims, technician or not (codex round 10 P1).
    const dryStateWithTechnician = !SAFE_COMPARATIVE.test(clause)
      && DRY_STATE.test(beside) && TECHNICIAN_CONFIRMS.test(beside)
      && !FIXED_REENTRY_TIME.test(clause) && !AUDIENCE_ABSOLUTE.test(clause);
    if (!dryStateWithTechnician) return clause;
  }
  return null;
}

// --- fixed_reentry_time ----------------------------------------------------
//
// AGENTS.md: never a fixed re-entry or drying minute figure, with or without
// the word "safe" — "Keep children and pets off the treated lawn for 30
// minutes", "the spray dries in about 20 minutes", "wait two hours before
// letting the dog out". The idiom is "until dry / once dry" with the
// technician confirming the timing. Watering/mowing intervals from a label
// ("postpone watering or mowing for 24 hours") are not re-entry guidance and
// are not matched; "dry season" is not a drying state.
const REENTRY_CONTEXT = /\b(?:keep|stay|staying|remain|remaining)\b[^.]{0,40}?\boff\b|\boff\s+(?:the\s+|your\s+)?(?:lawn|grass|yard|turf|treated\s+\w+)\b|\bre-?ent(?:ry|er)\w*|\b(?:let|letting|allow|allowing)\s+(?:the\s+|your\s+)?(?:pets?|kids?|children|dogs?|cats?|family|people|anyone|everyone)\b|\b(?:pets?|kids?|children|dogs?|cats?|people|anyone|everyone)\b[^.]{0,20}?\b(?:back|out|onto|inside|indoors|outside)\b|\b(?:walk|walking|play|playing)\s+on\b|\bdr(?:y|ies|ied|drying)\b(?!\s+(?:season|weather|spell|conditions|months?|winter|fall|spring|out))/i;

// Clause-bound: the figure and the re-entry/drying context must share a
// clause, so a label sentence that mentions "24 hours" of rain-free weather
// in one clause and "until the spray has dried" in another is not a fixed
// drying time.
function reentryTimeInSentence(sentence) {
  const canonical = canonicalFinding(sentence);
  if (canonical?.isDuration) return sentence;
  for (const clause of splitClauses(sentence)) {
    if (FIXED_REENTRY_TIME.test(clause) && REENTRY_CONTEXT.test(clause)) return clause;
  }
  return null;
}

// The safety and re-entry rules are about a TREATMENT: in copy that is not
// all about treatments (the weekly events guide, which now sources the same
// register facts), they apply only to sentences that talk about one — "our
// treatment is safe once dry" is caught, "a family-safe fun run" is not
// (codex round 15 P1). The pest-fact rules need no such scope: a false
// termite or large-patch claim is false in any newsletter.
// A product or service noun is treatment talk when Waves owns it ("our
// lawn solution", "the Waves approach", "Waves' service"; codex rounds 16–18)
// or a pest/lawn word qualifies it ("the pest-control method", "a lawn
// option") — every noun of the safety predicate's own PRODUCT_NOUNS, never a
// second list. Nouns that only ever name a product ("formula", "solution",
// "ingredients") count on their own. A bare generic noun ("a family-safe
// program of concerts", "the safest way to the fireworks") stays event copy.
const PEST_QUALIFIER = '(?:pest|lawn|mosquito|termite|rodent|ants?|fleas?|roach|bug|weed|fertiliz\\w*|irrigation|yard|turf|indoor|outdoor|perimeter)';
const TREATMENT_CONTEXT = new RegExp(
  '\\b(?:treat\\w*|spray\\w*|pesticides?|insecticides?|herbicides?|chemicals?|applied|appl(?:y|ies|ying)'
  + '|formulas?|formulations?|solutions?|ingredients?|repellents?'
  + '|technicians?|barriers?|baits?|granul\\w*|dusts?|fogg\\w*|misting|exterminat\\w*|fumigat\\w*|waveguard'
  + '|re-?ent(?:ry|er)\\w*|(?:once|until|when|after)\\s+(?:it\\s+(?:is|has)\\s+)?dr(?:y|ied|ies)'
  + `|${PEST_QUALIFIER}[-\\s]+(?:control[-\\s]+)?(?:control|care|defense|${PRODUCT_NOUNS})`
  + `|(?:our|waves[\'’]?s?|the\\s+waves|waves\\s+pest\\s+control(?:[\'’]s)?)\\s+(?:[\\w-]+\\s+){0,2}?(?:${PRODUCT_NOUNS}|visits?|crew|team))\\b`,
  'i',
);
// A sentence whose subject is a pronoun or demonstrative ("It is safe for
// pets.", "These are safe once dry.") refers back to the sentence before it:
// when that one is about a treatment, so is this one — the same carry-over
// the termite and lawn-disease rules give a pronoun subject.
const REFERRING_WORD = /\b(?:it|its|it's|they|them|their|this|these|those|both)\b/i;
function treatmentContextFlags(sentences) {
  const flags = [];
  for (let i = 0; i < sentences.length; i += 1) {
    flags.push(TREATMENT_CONTEXT.test(sentences[i])
      || (i > 0 && flags[i - 1] && REFERRING_WORD.test(sentences[i])));
  }
  return flags;
}
const CLAIM_RULES = [
  { rule: 'termite_second_swarm', find: (sentence, previous) => termiteClaimInSentence(sentence, previous) },
  { rule: 'large_patch_summer_disease', find: (sentence, previous) => patchClaimInSentence(sentence, previous) },
  { rule: 'non_flea_vacuum_advice', find: (sentence) => vacuumClaimInSentence(sentence) },
  { rule: 'absolute_safety_claim', treatmentScoped: true, find: (sentence) => safetyClaimInSentence(sentence) },
  { rule: 'fixed_reentry_time', treatmentScoped: true, find: (sentence) => reentryTimeInSentence(sentence) },
];

/**
 * Scan customer-facing copy for the known-false/overreaching claim shapes
 * above. Returns one { rule, excerpt } per rule that matched (never more
 * than one per rule, mirroring findHallucinatedClaims' one-per-label shape);
 * the excerpt is the offending clause. Every sentence is checked — one
 * exempt mention does not clear a LATER, non-exempt occurrence of the same
 * shape. `treatmentContextOnly` confines the treatment-scoped rules to
 * sentences that talk about a treatment (see TREATMENT_CONTEXT), directly or
 * through a pronoun that refers back to one.
 */
function findUnverifiedClaims(text, { treatmentContextOnly = false } = {}) {
  const body = normaliseText(text);
  if (!body) return [];
  const sentences = splitSentences(body);
  const inTreatmentContext = treatmentContextOnly ? treatmentContextFlags(sentences) : null;
  const results = [];
  for (const { rule, find, treatmentScoped } of CLAIM_RULES) {
    for (let i = 0; i < sentences.length; i += 1) {
      if (treatmentContextOnly && treatmentScoped && !inTreatmentContext[i]) continue;
      const hit = find(sentences[i], i > 0 ? sentences[i - 1] : '');
      if (hit) {
        results.push({ rule, excerpt: hit.trim().slice(0, 160) });
        break; // one result per rule, mirroring findHallucinatedClaims
      }
    }
  }
  return results;
}

/**
 * The register as a prompt block for an AI writer: every usable fact with
 * its quoted source text and the note on what the source does not state,
 * followed by the rule that binds the writer to it. Syncs the register
 * first (on-demand ensure; a sync failure is logged and the stored facts are
 * used). Throws when no fact can be loaded — a Pest Insider draft written
 * without its facts is exactly the ungrounded copy this register exists to
 * stop, so the draft fails instead.
 */
async function factsPromptBlock({ limit = 40, ensure = true, now = new Date() } = {}) {
  if (ensure) {
    try {
      await ensureFactRegister({ now });
    } catch (err) {
      logger.warn(`[fact-register] on-demand sync failed, using stored facts: ${err.message}`);
    }
  }
  const facts = await listFacts({ limit, now });
  if (!facts.length) throw new Error('fact register is empty: no verified facts to ground the draft');
  const lines = facts.map((fact) => {
    const meta = parseJson(fact.metadata, {}) || {};
    return `- ${fact.title}\n  Source text: ${fact.summary}\n  What this means and what the source does NOT say: ${fact.content}\n  Source: ${meta.source_url || 'on file'}`;
  });
  return `

VERIFIED FACTS — the ONLY source for statements about when a pest is active, how a product works, how long anything takes, and what a rule requires:
${lines.join('\n')}

RULES FOR FACTS:
- State such a fact only if it is in the list above, and keep its numbers and months exactly as written there.
- If the list does not cover a claim, leave the claim out. Do not estimate, round, or supply a number from general knowledge.
- Never write a number of days, weeks or months that does not appear in the list.
- Where a fact says its source does not state something, do not state it.`;
}

module.exports = {
  listFacts,
  findUnverifiedClaims,
  factsPromptBlock,
  syncFactRegister,
  ensureFactRegister,
  SOURCE,
};

module.exports._internals = {
  planFactSync,
  planStraySync,
  factFingerprint,
  rowFingerprint,
  hasProvenance,
  splitSentences,
  splitClauses,
  resetEnsureStamp: () => { lastEnsureAt = null; },
};
