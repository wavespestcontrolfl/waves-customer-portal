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
function managedMetadataCurrent(meta, fact) {
  return (meta.expires_on ?? null) === (fact.expiresOn ?? null)
    && (meta.derived === true) === (fact.derived === true)
    && meta.verified_on === VERIFIED_ON
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
    return { action: 'retire', reason: 'expired', keepDeactivation: !row.active && !meta.retired_reason };
  }
  if (!legacy && rowHash !== meta.register_hash && !converged) {
    return { action: 'hold', reason: 'edited_by_person', rowHash, shippedHash };
  }
  // active=false with no retirement stamp is a person's deactivation (the
  // admin knowledge routes write arbitrary columns); the register does not
  // switch it back on — nor after it retired and un-retired the row.
  if (!row.active && (!meta.retired_reason || meta.deactivated_by_person)) return { action: 'hold', reason: 'deactivated_by_person' };
  const sameWording = converged || (!legacy && meta.register_hash === shippedHash);
  if (sameWording && !converged && row.active && managedMetadataCurrent(meta, fact)) return { action: 'unchanged' };
  return { action: 'update', legacy, reactivate: !row.active, metadataOnly: sameWording, converged };
}

/**
 * Pure: a register row whose slug is no longer in the register. Retired when
 * untouched (or legacy), held when a person edited it, ignored when it is
 * not the register's row at all.
 */
function planStraySync(row) {
  if (!row || row.source !== SOURCE) return { action: 'ignore' };
  if (row.status === 'archived') return { action: 'unchanged' };
  const meta = parseJson(row.metadata, {}) || {};
  if (meta.register_hash && rowFingerprint(row) !== meta.register_hash) {
    return { action: 'hold', reason: 'edited_by_person', rowHash: rowFingerprint(row), shippedHash: meta.register_hash };
  }
  // A withdrawn fact archives even when a person had already set
  // active=false (shared search reads status); that deactivation is kept.
  return { action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: !row.active && !meta.retired_reason };
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
    verified_on: VERIFIED_ON,
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
    last_verified_at: new Date(`${VERIFIED_ON}T00:00:00Z`),
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

async function applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, result }) {
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
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.seeded, created, { verified_on: VERIFIED_ON });
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
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.retired, row, {
        reason: plan.reason, status_before_retire: row.status, deactivated_by_person: plan.keepDeactivation === true,
      });
      result.retired.push(row.slug);
      return;
    }
    case 'hold':
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
  const today = etDateString(now);

  for (const fact of facts) {
    try {
      await conn.transaction(async (trx) => {
        const row = await trx('knowledge_base').where({ slug: fact.slug }).forUpdate().first();
        const priorSeed = row ? false : await seededBefore(trx, hasAuditLog, fact.slug);
        const plan = planFactSync(fact, row, { today, priorSeed });
        await applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, result });
      });
    } catch (err) {
      result.errors.push({ slug: fact.slug, error: err.message });
      logger.warn(`[fact-register] sync failed for ${fact.slug}: ${err.message}`);
    }
  }

  if (retireStrays) {
    const strays = await conn('knowledge_base')
      .where({ source: SOURCE, category: CATEGORY })
      .whereNot({ status: 'archived' })
      .whereNotIn('slug', facts.map((fact) => fact.slug))
      .select('id', 'slug');
    for (const stray of strays) {
      try {
        await conn.transaction(async (trx) => {
          const row = await trx('knowledge_base').where({ id: stray.id }).forUpdate().first();
          const plan = planStraySync(row);
          if (plan.action === 'ignore') return;
          await applyFactPlan(trx, { slug: row.slug }, row, plan, { now, today, hasAuditLog, result });
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
    .where({ category: CATEGORY, source: SOURCE, active: true, status: 'active' })
    .orderBy('title', 'asc');

  const today = etDateString(now);
  const usable = rows.filter((row) => hasProvenance(row, today));
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

function splitSentences(text) {
  const shielded = text.replace(ABBREVIATION, (abbr) => abbr.slice(0, -1) + PROTECTED_DOT);
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
const TERMITE_MENTION = /\b((?:[\w'-]+\s+){0,3}?)termites?\b/gi;
const PRONOUN_SUBJECT = /\b(?:they|them|these\s+(?:insects|pests|bugs|termites)|the\s+colony|colonies|the\s+swarmers?|swarmers|alates)\b/i;
const SWARM_WORD = /\b(?:swarm\w*|fl(?:y|ies|ew|ying|own)|flights?|take\s+flight|took\s+flight|taking\s+flight|alates?|winged|emerg\w+|come\s+out|coming\s+out|came\s+out)\b/i;
const REPEAT_TRIGGER = /\b(?:second|another|again|repeat\w*|twice|once\s+more|all\s+over\s+again|late[-\s]?summer|summer(?:s|time)?|storms?|hurricanes?|post[-\s]?storms?|tropical|rainy\s+season)\b/i;

// The kind of termite the last mention in `text` names: 'drywood',
// 'other', or null when no termite is mentioned.
function lastTermiteKind(text) {
  let kind = null;
  for (const match of text.matchAll(TERMITE_MENTION)) {
    kind = /\bdrywood\b/i.test(match[1]) ? 'drywood' : 'other';
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
    else if (subject === null && PRONOUN_SUBJECT.test(clause)) subject = lastTermiteKind(previousSentence);
    if (subject !== 'other') continue;
    if (!SWARM_WORD.test(clause) || !REPEAT_TRIGGER.test(clause)) continue;
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
// patch together with summer, the summer months, the rainy season or
// above-80°F is the claim; UF's own "occurs in warm, humid weather" is not.
const PATCH = /\b(?:brown|large)\s+patch\b/i;
const PATCH_TRIGGER = /\b(?:summer(?:s|time)?|above[-\s]?80|june|july|august|september|rainy\s+season|hot\s+months?)\b/i;
const PATCH_CONTRAST = /\b(?:unlike|differs?\s+from|different\s+from|distinct\s+from|confused\s+with|mistaken\s+for|instead\s+of|rather\s+than)\b/i;

function patchClaimInSentence(sentence) {
  const clauses = splitClauses(sentence);
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (!PATCH.test(clause) || !PATCH_TRIGGER.test(clause)) continue;
    if (clauseDenies(clause, PATCH_CONTRAST) || previousClauseIsMythLabel(clauses, i)) continue;
    return clause;
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
// for 14 days" is a made-up number even in a flea sentence.
const VACUUM = /\bvacuum\w*\b/i;
const DURATION = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|a\s+few|several|a\s+couple\s+of)\s*(?:(?:to|-|–)\s*(?:\d+|one|two|three|four)\s*)?(?:days?|weeks?)\b/gi;
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
const SAFE_COMPOUND = /\b(?:bee|pet|family|kid|child|children|baby|dog|cat|people|human|eco|environment(?:ally)?|earth|planet)-safe\b/i;
// Copula forms ("is safe"), prepositional forms ("safe for / around / once
// dry"), and the bare adjective on a product or service ("our safe lawn
// treatment", "a safe, effective spray", "the safe choice"). Not: "safe
// from" (protection), "safe to say", "a safe distance / place / bet".
const SAFE_PRODUCT_NOUN = '(?:lawn|pest|termite|mosquito|rodent|ant|flea|indoor|outdoor|home|yard|residential|commercial)?\\s*(?:treatments?|products?|sprays?|formulas?|formulations?|applications?|options?|choices?|ways?|solutions?|pesticides?|insecticides?|herbicides?|chemicals?|services?|barriers?|alternatives?|approach(?:es)?|methods?|programs?|plans?|ingredients?|materials?)';
const SAFE_IDIOM_NOUN = '(?:from|to\\s+say|bet|distance|place|space|side|harbou?r|haven|spot|room|hands|travels?|trip|journey|holiday|weekend|season|drive|passage)';
const SAFE_CLAIM = new RegExp(
  `\\b(?:is|are|it's|its|be|being|remains?|becomes?|considered|deemed|completely|totally|perfectly|entirely|100%)\\s+(?:\\w+\\s+)?safe\\b(?!\\s+${SAFE_IDIOM_NOUN}\\b)`
  + '|\\bsafe\\s+(?:for|around|near|with|once|when|after|as\\s+soon\\s+as)\\b'
  + '|\\bsafe\\s+to\\s+(?!say\\b)\\w+',
  'i',
);
// The bare adjective on a product noun, tested on the whole sentence: "a
// safe, effective spray" spans the comma a clause split would cut at.
const SAFE_ADJECTIVE_PRODUCT = new RegExp(`\\bsafe(?:,?\\s+(?:and\\s+)?\\w+)?\\s+${SAFE_PRODUCT_NOUN}\\b`, 'i');
const TECHNICIAN_CONFIRMS = /\btechnicians?\b[^.]{0,80}\b(?:confirm|tell|let\s+you\s+know|advise|say|give)|\b(?:confirm|tell|advise|check)\w*[^.]{0,40}\btechnicians?\b/i;
// The technician idiom exempts ONLY dry-state re-entry guidance: "safe once
// dry / when it has dried, and your technician confirms the timing". It
// never exempts an absolute audience claim ("safe for children and pets")
// or a fixed re-entry time ("safe after 15 minutes"), technician or not.
const DRY_STATE = /\b(?:once|when|after|until)\b[^.,;]{0,40}?\b(?:dry|dried|dries)\b|\b(?:has|have)\s+dried\b|\bdry\s+to\s+the\s+touch\b/i;
const FIXED_REENTRY_TIME = /\b(?:\d+|one|two|three|four|five|six|eight|ten|twelve|fifteen|twenty|thirty|forty-?five|sixty|ninety|half\s+an|a\s+couple\s+of|a\s+few|an?)\s*(?:minutes?|mins?|hours?|hrs?)\b/i;
const AUDIENCE_ABSOLUTE = /\bsafe\s+(?:for|around|near|with)\s+(?:the\s+|your\s+|our\s+)?(?:bees?|pets?|kids?|children|babies|dogs?|cats?|people|humans?|(?:whole\s+|entire\s+)?family)\b/i;

// The dry-state + technician exemption is bound to the CLAIM's clause: the
// dry condition and the technician confirmation must sit in that clause or
// the one right beside it. "The treatment is safe and works after it dries;
// your technician confirms timing" is not the idiom — "after it dries"
// modifies "works", and the technician clause is two clauses away.
function safetyClaimInSentence(sentence) {
  if (reentrySafetyClaimFinding(sentence)) return sentence;
  if (SAFE_COMPOUND.test(sentence) || SAFE_ADJECTIVE_PRODUCT.test(sentence)) return sentence;
  const clauses = splitClauses(sentence);
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (!SAFE_CLAIM.test(clause)) continue;
    const beside = [clauses[i - 1], clause, clauses[i + 1]].filter(Boolean).join(' ');
    const dryStateWithTechnician = DRY_STATE.test(beside) && TECHNICIAN_CONFIRMS.test(beside)
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
  const canonical = reentrySafetyClaimFinding(sentence);
  if (canonical && /\b(?:minutes?|mins?|hours?|hrs?)\b/i.test(canonical.message || '')) return sentence;
  for (const clause of splitClauses(sentence)) {
    if (FIXED_REENTRY_TIME.test(clause) && REENTRY_CONTEXT.test(clause)) return clause;
  }
  return null;
}

const CLAIM_RULES = [
  { rule: 'termite_second_swarm', find: (sentence, previous) => termiteClaimInSentence(sentence, previous) },
  { rule: 'large_patch_summer_disease', find: (sentence) => patchClaimInSentence(sentence) },
  { rule: 'non_flea_vacuum_advice', find: (sentence) => vacuumClaimInSentence(sentence) },
  { rule: 'absolute_safety_claim', find: (sentence) => safetyClaimInSentence(sentence) },
  { rule: 'fixed_reentry_time', find: (sentence) => reentryTimeInSentence(sentence) },
];

/**
 * Scan customer-facing copy for the known-false/overreaching claim shapes
 * above. Returns one { rule, excerpt } per rule that matched (never more
 * than one per rule, mirroring findHallucinatedClaims' one-per-label shape);
 * the excerpt is the offending clause. Every sentence is checked — one
 * exempt mention does not clear a LATER, non-exempt occurrence of the same
 * shape.
 */
function findUnverifiedClaims(text) {
  const body = normaliseText(text);
  if (!body) return [];
  const sentences = splitSentences(body);
  const results = [];
  for (const { rule, find } of CLAIM_RULES) {
    for (let i = 0; i < sentences.length; i += 1) {
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
