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
 *    edited, with an audit row saying so. Runs daily (scheduler.js) and on
 *    demand before a draft.
 * 2. Lists the usable facts with their provenance checked: only register
 *    rows the sync stamped, with a source URL and a quote, active,
 *    status 'active' (the weekly knowledge-base audit hides a doubtful entry
 *    by setting status 'flagged'), and not expired.
 * 3. Flags a small, deterministic set of known-false or overreaching claim
 *    shapes so the newsletter validator can hard-block them before a draft
 *    is proofed or sent.
 *
 * The claim rules are a tripwire, not a proof: a false hold costs one proof
 * review, a false pass mails a wrong claim to the list. So every exemption
 * below is an ALLOWLIST of explicit denial shapes for that one claim — never
 * "the clause contains a negation word", which lets idioms ("no doubt", "no
 * joke", "never fails to", "not only") and unrelated asides clear a real
 * false claim.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
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

/**
 * Pure: what the sync does with one register fact given the row currently
 * stored under its slug (or none). Never touches a row a person edited.
 *
 * A register row with no register_hash predates fingerprinting (the seed
 * migrations of the first three cuts of this lane, present only in
 * preview/QA databases) — it is the register's own writing, brought under
 * management like an untouched row; a person's edit to one of those cannot
 * be told apart, and the alternative leaves superseded content live in the
 * writer's prompt.
 */
function planFactSync(fact, row, { today } = {}) {
  const expired = isExpired(fact, today);
  if (!row) return expired ? { action: 'skip', reason: 'expired_never_seeded' } : { action: 'insert' };
  if (row.source !== SOURCE) return { action: 'hold', reason: 'foreign_row' };

  const meta = parseJson(row.metadata, {}) || {};
  const shippedHash = factFingerprint(fact);
  const legacy = !meta.register_hash;
  const rowHash = rowFingerprint(row);
  if (!legacy && rowHash !== meta.register_hash) {
    return { action: 'hold', reason: 'edited_by_person', rowHash, shippedHash };
  }
  if (expired) return row.active ? { action: 'retire', reason: 'expired' } : { action: 'unchanged' };
  const sameWording = !legacy && meta.register_hash === shippedHash;
  if (sameWording && row.active && managedMetadataCurrent(meta, fact)) return { action: 'unchanged' };
  return { action: 'update', legacy, reactivate: !row.active, metadataOnly: sameWording };
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
 * Pure: a register row whose slug is no longer in the register. Retired when
 * untouched (or legacy), held when a person edited it, ignored when it is
 * not the register's row at all.
 */
function planStraySync(row) {
  if (!row || row.source !== SOURCE) return { action: 'ignore' };
  if (!row.active) return { action: 'unchanged' };
  const meta = parseJson(row.metadata, {}) || {};
  if (meta.register_hash && rowFingerprint(row) !== meta.register_hash) {
    return { action: 'hold', reason: 'edited_by_person', rowHash: rowFingerprint(row), shippedHash: meta.register_hash };
  }
  return { action: 'retire', reason: 'withdrawn_from_register' };
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

// One hold audit per (row, shipped content, row content): the daily run
// must not append the same hold every day.
async function auditHold(trx, hasAuditLog, row, plan) {
  if (!hasAuditLog) return;
  const last = await trx('audit_log')
    .where({ action: AUDIT_ACTIONS.held, resource_type: 'knowledge_base', resource_id: row.id })
    .orderBy('created_at', 'desc')
    .first();
  const lastMeta = last ? (parseJson(last.metadata, {}) || {}) : null;
  if (lastMeta && lastMeta.reason === plan.reason
    && lastMeta.shipped_hash === (plan.shippedHash || null)
    && lastMeta.row_hash === (plan.rowHash || null)) return;
  await audit(trx, hasAuditLog, AUDIT_ACTIONS.held, row, {
    reason: plan.reason, shipped_hash: plan.shippedHash || null, row_hash: plan.rowHash || null,
  });
}

async function applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, result }) {
  switch (plan.action) {
    case 'insert': {
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
        .onConflict('slug')
        .ignore()
        .returning(['id', 'slug']);
      const created = Array.isArray(inserted) ? inserted[0] : null;
      if (!created?.id) { result.unchanged.push(fact.slug); return; } // lost an insert race: the other writer's row stands
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
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.updated, row, {
        legacy_row: plan.legacy === true, reactivated: plan.reactivate === true, metadata_only: plan.metadataOnly === true,
        previous_hash: meta.register_hash || null, register_hash: factFingerprint(fact),
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
        metadata: JSON.stringify({ ...meta, retired_on: today, retired_reason: plan.reason, status_before_retire: row.status }),
      });
      await audit(trx, hasAuditLog, AUDIT_ACTIONS.retired, row, { reason: plan.reason, status_before_retire: row.status });
      result.retired.push(row.slug);
      return;
    }
    case 'hold':
      await auditHold(trx, hasAuditLog, row, plan);
      result.held.push({ slug: row.slug, reason: plan.reason });
      return;
    case 'skip':
      result.skipped.push({ slug: fact.slug, reason: plan.reason });
      return;
    default:
      result.unchanged.push(row?.slug || fact.slug);
  }
}

/**
 * Sync the code register into knowledge_base. Each fact is its own
 * transaction with the row locked, so a concurrent run (two instances, or
 * the cron beside an on-demand ensure) cannot double-write; an insert race
 * is absorbed by ON CONFLICT DO NOTHING. A row a person edited is never
 * overwritten — it is reported in `held` and audited once. Errors on one
 * fact never stop the others.
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
        const plan = planFactSync(fact, row, { today });
        await applyFactPlan(trx, fact, row, plan, { now, today, hasAuditLog, result });
      });
    } catch (err) {
      result.errors.push({ slug: fact.slug, error: err.message });
      logger.warn(`[fact-register] sync failed for ${fact.slug}: ${err.message}`);
    }
  }

  if (retireStrays) {
    const strays = await conn('knowledge_base')
      .where({ source: SOURCE, category: CATEGORY, active: true })
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
 * written by the sync, never a hand-made row in the same category), a
 * source URL and a quote on file, and not past its expiry. A row that
 * fails is never fed to a writer, whatever its category says.
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
  if (isExpired(FACT_BY_SLUG.get(row.slug), today)) return false;
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
 * flagged or archived fact straight into a customer-facing prompt. A row a
 * person edited (held by the sync) is still listed: the edit is the
 * operator's call and the knowledge-base audit reviews it.
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
// Known-false / overreaching claim shapes
// ---------------------------------------------------------------------------

// The words that make the termite claim false: a SECOND / repeat /
// late-summer / storm-triggered swarm (the January–May swarm "on warm days
// after rain" is the true fact and carries none of them).
const REPEAT_SWARM = '(?:second|another|again|repeat(?:ed)?|late[-\\s]?summer|post[-\\s]?storm|storm[-\\s]?(?:triggered|induced|driven)?)';
const NEGATOR = "(?:do(?:es)?\\s+not|don'?t|doesn'?t|did\\s+not|didn'?t|will\\s+not|won'?t|cannot|can'?t|never)";
const SWARM_VERB = '(?:have|throw|produce|swarm|get|trigger|stage|make|fly)';
// "swarm again", "swarm (for) a second time", "swarm twice", "swarm once more"
const SECOND_TIME = '(?:again|(?:for\\s+)?a\\s+second\\s+time|twice|once\\s+more)';
// The swarming verb forms that take SECOND_TIME.
const SWARM_OR_FLY = '(?:swarm(?:s|ed|ing)?|fl(?:y|ies|ew|ying))';
// A swarm is also called a flight.
const SWARM_NOUN = '(?:swarm|flight)';
// The same idea when the modifier comes FIRST ("a second termite swarm",
// "another termite swarm"). "again" and a bare "storm" are left out here:
// they only make the claim false after the verb.
const REPEAT_MODIFIER = '(?:second|another|repeat(?:ed)?|late[-\\s]?summer|post[-\\s]?storm|storm[-\\s]?(?:triggered|induced|driven))';
// What may stand between a leading "No" and "termites" in a denial ("No
// native subterranean termites have a second swarm"): the species and
// qualifiers, never "doubt"/"wonder"/"question" ("No doubt these termites
// have a second swarm" is the false claim).
const TERMITE_QUALIFIER = '(?:native|subterranean|drywood|dampwood|florida|eastern|western|asian|formosan|invasive|local|known|documented|reticulitermes|coptotermes|species\\s+of|kind\\s+of|type\\s+of|of\\s+these|of\\s+our)';
// A subject standing in for termites named in the sentence before ("They
// swarm again after storms."). Only a claim when the surrounding text is
// about (non-drywood) termites — see isTermiteContext.
const PRONOUN_SUBJECT = '(?:they|these\\s+(?:insects|pests|bugs)|the\\s+colony|colonies)';
// The span a denial's negation may reach across: no clause break, no dash.
const DENIAL_SPAN = '[^.,;:—–-]{0,60}?';

// "X is a myth" / "Myth: X" — the claim named as a falsehood. Bound to the
// MATCHED claim, never to the sentence around it: the myth phrase must sit
// right after the match inside the same clause ("... a second termite swarm
// after storms is a myth"), or right before it as a label ("Myth: termites
// swarm again after storms"). A myth phrase in ANOTHER clause of the same
// sentence ("Termites swarm again after storms, but winter swarms are a
// myth") clears nothing. At most three words may stand between the match
// and the verb ("outbreaks are a myth", "after storms is a myth").
const MYTH_SUFFIX = /^\s*(?:[\w'’-]+\s+){0,3}?(?:is|are|was|were|remains?)\s+(?:just\s+|only\s+|simply\s+)?(?:a\s+|an\s+)?(?:myth|misconception|misunderstanding|old\s+wives'?\s+tale|folklore)\b/i;
const MYTH_PREFIX = /\bmyth\s*[:—–-]\s*(?:that\s+)?$/i;
// Where a clause ends after the match: a period, comma, semicolon, colon,
// em/en dash, or a spaced hyphen (never the hyphen inside "late-summer").
const CLAUSE_BREAK_AFTER = /[.,;:—–]|\s-\s/;

// Known-false or overreaching claim shapes an AI-written newsletter draft
// must never state. `denials` lists the ONLY phrasings that exempt an
// occurrence: the rule's own correct fact stated as a denial of that claim.
const UNVERIFIED_CLAIM_RULES = [
  {
    // The September 2026 Pest Insider draft's actual error: native
    // subterranean termites do NOT have a second, storm/late-summer
    // triggered swarm (fact-no-storm-triggered-second-termite-swarm). Word
    // orders: "... a second swarm/flight", "... swarm again / (for) a second
    // time", "a second termite swarm", and a pronoun subject in termite
    // context. The anchor's negative lookbehind keeps a drywood subject out:
    // both drywood species correctly document wide, near-any-month flight
    // windows, while a contrastive "Unlike drywood termites, native
    // subterranean termites have a second swarm" still anchors on — and
    // blocks — the second, non-drywood "termites".
    rule: 'termite_second_swarm',
    pattern: new RegExp(
      `\\b(?<!drywood[\\s-])termites?\\b[^.]{0,150}?\\b${REPEAT_SWARM}\\b[^.]{0,60}?\\b${SWARM_NOUN}`
      + `|\\b(?<!drywood[\\s-])termites?\\b[^.]{0,80}?\\b${SWARM_OR_FLY}\\s+${SECOND_TIME}\\b`
      // modifier first: "a second termite swarm", "another subterranean
      // termite flight" — never when the termite named is a drywood.
      + `|\\b${REPEAT_MODIFIER}\\s+(?!(?:[\\w-]+\\s+){0,2}?drywood\\b)(?:[\\w-]+\\s+){0,2}?termite\\s+${SWARM_NOUN}`
      // pronoun subject: "They swarm again after storms", "they have a
      // second swarm" — a claim only in termite context (isExemptOccurrence).
      + `|\\b${PRONOUN_SUBJECT}\\b[^.]{0,40}?\\b${SWARM_OR_FLY}\\s+${SECOND_TIME}\\b`
      + `|\\b${PRONOUN_SUBJECT}\\b[^.]{0,40}?\\b${SWARM_VERB}\\b[^.]{0,30}?\\b(?:second|another|repeat(?:ed)?)\\s+${SWARM_NOUN}`,
      'i',
    ),
    denials: [
      // "termites do not have a second swarm", "termites never swarm again",
      // "termites do not swarm for a second time"
      new RegExp(`\\b${NEGATOR}\\s+${SWARM_VERB}\\b${DENIAL_SPAN}\\b(?:${REPEAT_SWARM}|${SECOND_TIME})`, 'i'),
      // "No native subterranean termites have a second swarm"
      new RegExp(`\\bno\\s+(?:${TERMITE_QUALIFIER}\\s+){0,4}?termites?\\s+${SWARM_VERB}\\b${DENIAL_SPAN}\\b${REPEAT_SWARM}`, 'i'),
      // "there is no second swarm" (never "there is no doubt ...")
      new RegExp(`\\b(?:there\\s+is|there'?s|there\\s+are)\\s+no\\s+(?:such\\s+)?${REPEAT_SWARM}\\b`, 'i'),
      // "no such thing as a second termite swarm"
      new RegExp(`\\bno\\s+such\\s+thing\\s+as\\s+(?:a\\s+|an\\s+)?${REPEAT_MODIFIER}\\b`, 'i'),
      // "no second termite swarm", "not a second termite swarm" — the
      // negation must sit directly on the modifier, so "no doubt a second
      // termite swarm" is still the false claim.
      new RegExp(`\\b(?:no|never)\\s+(?:such\\s+)?${REPEAT_MODIFIER}\\b`, 'i'),
      new RegExp(`\\bnot\\s+(?:a|an|any)\\s+${REPEAT_MODIFIER}\\b`, 'i'),
    ],
    mythDenial: true,
  },
  {
    // Large patch is "most likely to be observed from November through May
    // when temperatures are below 80°F" and "normally not observed in the
    // summer months" (fact-large-patch, UF/IFAS LH044). Only the summer and
    // above-80°F claims trip this rule: UF's own St. Augustinegrass guide
    // says large patch "occurs in warm, humid weather", so "warm weather"
    // is not a false claim and is not matched.
    rule: 'large_patch_summer_disease',
    pattern: /\b(?:brown|large)\s+patch\b[^.]{0,100}?\b(?:summer|above[-\s]?80)\b|\b(?:summer|above[-\s]?80\s*(?:°|degrees?)?)\b[^.]{0,100}?\b(?:brown|large)\s+patch\b/i,
    denials: [
      // "it is not a summer disease"
      /\b(?:is\s+not|isn'?t|are\s+not|aren'?t|it'?s\s+not|was\s+not|never)\s+(?:a\s+|an\s+)?summer\b/i,
      // "spring and fall, not in summer"
      /\bnot\s+(?:in|during)\s+(?:the\s+)?summer\b/i,
      // UF's own wording: "normally not observed in the summer months"
      /\bnot\s+(?:normally\s+|usually\s+)?(?:observed|seen|found|active)\s+(?:in|during)\s+(?:the\s+)?summer\b/i,
      // "summer brown spots are usually chinch bugs, not large patch";
      // "leaf and sheath spot ... is different from large patch"
      /\b(?:unlike|differs?\s+from|different\s+from|distinct\s+from|confused\s+with|mistaken\s+for|not)\s+(?:a\s+|the\s+)?(?:brown|large)\s+patch\b/i,
    ],
    mythDenial: true,
  },
  {
    // Continuing to vacuum after treatment is flea guidance: it stimulates
    // pupae to hatch into the treatment (fact-flea-vacuuming-after-treatment,
    // University of Kentucky ENTFACT-602). An instruction to vacuum for N
    // days or weeks is exempt only in a sentence about fleas; a NEGATED
    // instruction ("do not"/"avoid" vacuuming for N days) is never correct,
    // for fleas or anything else. Capture group 1 carries the negation.
    rule: 'non_flea_vacuum_advice',
    pattern: /\b((?:do\s*not|don'?t|avoid)\s+)?vacuum(?:ing)?\b[^.]{0,80}?\b\d+\s*(?:days?|weeks?)\b/i,
  },
  {
    // Absolute safety guarantees no label supports (AGENTS.md: no safety or
    // efficacy claims). The label's own wording is the only safe one:
    // "Do not allow people or pets on treated surfaces until spray has
    // dried." Covers bees, pets, dogs, cats, kids, children, babies and the
    // family, hyphenated ("pet-safe") or "safe for/around (your) pets".
    rule: 'absolute_safety_claim',
    pattern: /\b(?:bee|pet|family|kid|child|baby|dog|cat)[-\s]?safe\b|\bsafe\s+(?:for|around)\s+(?:the\s+|your\s+|our\s+)?(?:bees|pets?|kids?|children|babies|dogs?|cats?|(?:whole\s+|entire\s+)?family)\b/i,
  },
];

// The sentence an occurrence sits in: from the period before the match (or
// text start) to the period after it (or text end).
function sentenceWindow(body, match) {
  const idx = match.index ?? 0;
  const end = idx + match[0].length;
  const start = body.lastIndexOf('.', idx) + 1; // 0 when no prior '.'
  const stop = body.indexOf('.', end);
  return body.slice(start, stop === -1 ? body.length : stop);
}

// The sentence before the one the occurrence sits in (for a pronoun subject
// whose noun is in the previous sentence).
function previousSentence(body, match) {
  const idx = match.index ?? 0;
  const thisStart = body.lastIndexOf('.', idx);
  if (thisStart <= 0) return '';
  const prevStart = body.lastIndexOf('.', thisStart - 1) + 1;
  return body.slice(prevStart, thisStart);
}

// Where a denial may sit: from the start of the match's own clause (the
// nearest period, comma or semicolon before it, so a leading "No native
// subterranean termites ..." counts) to the END OF THE MATCH. Nothing after
// the match is read: a trailing "..., not that anyone believes it" and a
// correct denial elsewhere in the same sentence must not clear this
// occurrence.
function denialWindow(body, match) {
  const idx = match.index ?? 0;
  const before = body.slice(0, idx);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf(','), before.lastIndexOf(';')) + 1;
  return body.slice(start, idx + match[0].length);
}

// A global clone of a rule's pattern — matchAll needs the 'g' flag, and a
// single `body.match(pattern)` only ever checks the FIRST occurrence: a
// draft repeating a rule's shape (one exempt mention, then a real one)
// would have the exempt first match wrongly clear the whole rule.
function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

const PRONOUN_START = new RegExp(`^${PRONOUN_SUBJECT}\\b`, 'i');

// True when the matched claim itself is named a myth: "<claim> is a myth"
// within the same clause, or "Myth: <claim>" directly before it.
function isNamedAsMyth(body, match) {
  const idx = match.index ?? 0;
  const end = idx + match[0].length;
  const rest = body.slice(end);
  const breakAt = rest.search(CLAUSE_BREAK_AFTER);
  const suffix = breakAt === -1 ? rest : rest.slice(0, breakAt);
  if (MYTH_SUFFIX.test(suffix)) return true;
  const before = body.slice(0, idx);
  const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf(','), before.lastIndexOf(';')) + 1;
  return MYTH_PREFIX.test(before.slice(clauseStart));
}

// A pronoun-subject occurrence is the termite claim only when this sentence
// or the one before it names termites and neither names a drywood species.
function isTermiteContext(body, match) {
  const context = `${previousSentence(body, match)} ${sentenceWindow(body, match)}`;
  return /\btermites?\b/i.test(context) && !/\bdrywood\b/i.test(context);
}

// True when THIS occurrence is the rule's own correct fact (one of its
// allowlisted denial shapes, or — vacuum rule only — the affirmative
// instruction in a sentence about fleas), not the false claim.
function isExemptOccurrence(body, match, { rule, denials, mythDenial }) {
  if (rule === 'termite_second_swarm' && PRONOUN_START.test(match[0]) && !isTermiteContext(body, match)) return true;
  if (Array.isArray(denials) && denials.length) {
    const window = denialWindow(body, match);
    if (denials.some((denial) => denial.test(window))) return true;
  }
  if (mythDenial && isNamedAsMyth(body, match)) return true;
  if (rule === 'non_flea_vacuum_advice') {
    const negated = !!match[1];
    if (!negated && /\bflea/i.test(sentenceWindow(body, match))) return true;
  }
  return false;
}

/**
 * Scan customer-facing copy for the known-false/overreaching claim shapes
 * above. Returns one { rule, excerpt } per rule that matched (never more
 * than one per rule, mirroring findHallucinatedClaims' one-per-label shape).
 * Every occurrence of a rule's pattern is checked — one exempt mention does
 * not clear a LATER, non-exempt occurrence of the same shape.
 */
function findUnverifiedClaims(text) {
  const body = String(text ?? '');
  if (!body) return [];
  const results = [];
  for (const claimRule of UNVERIFIED_CLAIM_RULES) {
    for (const match of body.matchAll(globalPattern(claimRule.pattern))) {
      if (isExemptOccurrence(body, match, claimRule)) continue;
      results.push({ rule: claimRule.rule, excerpt: match[0].trim().slice(0, 160) });
      break; // one result per rule, mirroring findHallucinatedClaims
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
  UNVERIFIED_CLAIM_RULES,
  resetEnsureStamp: () => { lastEnsureAt = null; },
};
