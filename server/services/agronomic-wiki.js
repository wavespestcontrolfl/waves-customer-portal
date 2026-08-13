/**
 * Agronomic Intelligence Wiki Service
 *
 * Core service that links treatment outcomes to before/after assessments,
 * generates and maintains AI-written wiki pages, and provides search/read
 * access for other portal systems.
 */

const db = require('../models/db');
const logger = require('./logger');
const { loadCustomerGrassContext, irrigationTypeHasSystem } = require('./lawn-grass-context');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = require('../config/models').DEEP;
const { createDeepMessage } = require('./llm/deep');

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

// Escape LIKE/ILIKE metacharacters so product names containing literal
// "%" or "_" (e.g. "LESCO High Manganese Combo AM 1% Mg 5.75% S ...")
// match as text instead of acting as wildcards. Pair with ESCAPE '\'.
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (m) => `\\${m}`);
}

// Assessment-pairing recency windows. An unbounded pre/post lookup can pair
// a treatment with an assessment from a different program season, producing
// meaningless deltas. Bounds are generous on purpose — the lawn program runs
// ~monthly visits.
const PRE_ASSESSMENT_MAX_AGE_DAYS = 180;
const POST_ASSESSMENT_MAX_DAYS = 60;

function daysFrom(date, days) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}

// Resolve a free-text applied-product name to its canonical catalog product.
// service_products rows carry whatever name the closeout stored, and the same
// physical product appears under multiple vendor listing names — keying wiki
// pages on the raw string splits one product's outcome data across pages.
// Returns the canonical name plus every known name variant (catalog name +
// aliases) so outcome aggregation covers all spellings.
async function resolveCanonicalProduct(productName) {
  const fallback = { canonicalName: productName, variants: [productName] };
  if (!productName) return fallback;
  try {
    let catalogRow = await db('products_catalog')
      .whereRaw('LOWER(name) = ?', [productName.toLowerCase()])
      .first('id', 'name');
    if (!catalogRow) {
      const alias = await db('product_aliases')
        .whereRaw('LOWER(alias_name) = ?', [productName.toLowerCase()])
        .first('product_id');
      if (alias?.product_id) {
        catalogRow = await db('products_catalog')
          .where({ id: alias.product_id })
          .first('id', 'name');
      }
    }
    if (!catalogRow) return fallback;

    const aliasRows = await db('product_aliases')
      .where({ product_id: catalogRow.id })
      .select('alias_name');
    const variants = [...new Set(
      [catalogRow.name, ...aliasRows.map((a) => a.alias_name), productName].filter(Boolean)
    )];
    return { canonicalName: catalogRow.name, variants };
  } catch (err) {
    logger.warn(`[agronomic-wiki] Canonical product lookup failed for "${productName}": ${err.message}`);
    return fallback;
  }
}

function getSeason(month) {
  if (month >= 4 && month <= 9) return 'peak';
  if (month === 3 || month === 10) return 'shoulder';
  return 'dormant';
}

function confidenceLevel(count) {
  if (count >= 50) return 'very_high';
  if (count >= 20) return 'high';
  if (count >= 5) return 'moderate';
  return 'low';
}

// ── Exception-based review tiers (owner directive 2026-07-06) ──────────────
// green  → auto-update, trusted immediately
// yellow → auto-update, trusted, listed in the weekly digest
// red    → excluded from agent-facing reads until a human approves
// Generation is NEVER blocked — the tier gates who may READ the page.
const TRUSTED_STATUSES = ['auto', 'approved'];

// Strong compliance signals only. Ordinary rate mentions in internal outcome
// aggregations stay green/yellow — the generation prompt frames everything as
// field intelligence, not label authority. These patterns catch content that
// reads as regulatory/label guidance, which is always review-required.
// Mirrored in migration 20260706000001 (backfill).
const COMPLIANCE_PATTERNS = [
  /\bblackout\b/i,
  /\bordinances?\b/i,
  /\brei\b/i,
  /\bre[- ]?entry interval/i,
  /\bdo[- ]not[- ]apply\b/i,
  /phytotox/i,
  /restricted[- ]use\b/i,
];

function classifyReviewTier({ confidence, content, hasOpenContradiction = false, openContradictionIds = [], externalSource = false }) {
  const flags = [];
  if (externalSource) flags.push('external_source');
  if (hasOpenContradiction || openContradictionIds.length) {
    flags.push('open_contradiction');
    // Identity flags, one per open contradiction: sticky approval compares
    // flag SETS, so a NEW contradiction must change the set even when
    // 'open_contradiction' was already present at approval time — otherwise
    // an approved-despite-contradiction page silently absorbs later ones.
    for (const id of [...openContradictionIds].sort()) flags.push(`contradiction:${id}`);
  }
  if (COMPLIANCE_PATTERNS.some((p) => p.test(content || ''))) flags.push('compliance_content');
  // A placeholder is never trusted, whatever its data-point confidence —
  // gate recomputes (contradiction cleared, review actions) reach this
  // classifier directly, with no generation-path special case in front of
  // them, so the stub check has to live here too.
  if ((content || '').includes('*Pending AI generation')) flags.push('generation_stub');
  if (confidence === 'low') flags.push('low_confidence');
  else if (confidence === 'moderate') flags.push('moderate_confidence');

  let tier = 'green';
  if (flags.includes('moderate_confidence')) tier = 'yellow';
  if (
    flags.includes('low_confidence') ||
    flags.includes('compliance_content') ||
    flags.includes('open_contradiction') ||
    flags.includes('external_source') ||
    flags.includes('generation_stub')
  ) tier = 'red';

  return { tier, flags };
}

function parseFlags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function sameFlagSets(a, b) {
  const setA = new Set(parseFlags(a));
  const setB = new Set(parseFlags(b));
  return setA.size === setB.size && [...setA].every((f) => setB.has(f));
}

// Resolve a page's review fields from fresh inputs, honoring the state
// machine: manual pins survive, human blocks hold, approval is sticky while
// the risk reasons don't GROW (shrinking risks keep the approval; any new
// reason re-gates). Used by BOTH the write path and the unchanged-data skip
// path — a new contradiction must re-gate a page even when its outcome data
// didn't change.
function resolveReviewFields(existing, { confidence, content, hasOpenContradiction, openContradictionIds }) {
  const existingFlags = parseFlags(existing?.risk_flags);
  if (existingFlags.includes('manual_override')) {
    // A pin overrides confidence/compliance judgment, NOT live exceptions:
    let flags = existingFlags;
    // ...a stale generation_stub never outlives real content (a red-pinned
    // stub must become approvable once a retry succeeds)...
    if (!(content || '').includes('*Pending AI generation')) {
      flags = flags.filter((f) => f !== 'generation_stub');
    }
    // ...and contradiction identity is recomputed fresh each pass — a NEW
    // open contradiction re-gates a pinned page (exception-based model),
    // while a fully cleared set drops the stale identity flags.
    const ids = [...(openContradictionIds || [])].sort();
    const identityFlags = ids.map((id) => `contradiction:${id}`);
    const newIds = identityFlags.filter((f) => !flags.includes(f));
    if (newIds.length) {
      return {
        tier: 'red',
        flags: [...new Set([...flags, 'open_contradiction', ...identityFlags])],
        reviewStatus: existing.review_status === 'blocked' ? 'blocked' : 'pending_review',
      };
    }
    if (!ids.length) {
      flags = flags.filter((f) => f !== 'open_contradiction' && !f.startsWith('contradiction:'));
    }
    return {
      tier: existing.review_tier,
      flags,
      reviewStatus: existing.review_status,
    };
  }
  const { tier, flags } = classifyReviewTier({ confidence, content, hasOpenContradiction, openContradictionIds });
  let reviewStatus = 'auto';
  if (tier === 'red') {
    // Sticky while no UNAPPROVED risk appears: a subset of the approved flag
    // set means risks only shrank (e.g. one of two contradictions resolved) —
    // re-review is needed only when a new reason arrives, not when an
    // already-reviewed one goes away.
    const approvedFlags = new Set(parseFlags(existing?.risk_flags));
    const stickyApproval = existing?.review_status === 'approved' && flags.every((f) => approvedFlags.has(f));
    reviewStatus = stickyApproval ? 'approved' : 'pending_review';
  }
  // Approval never sticks to a placeholder — real content must exist first.
  if (flags.includes('generation_stub') && reviewStatus === 'approved') reviewStatus = 'pending_review';
  if (existing?.review_status === 'blocked') reviewStatus = 'blocked';
  return { tier, flags, reviewStatus };
}

// Contradiction identities already recorded in a page's risk flags — the
// fail-closed fallback when the live lookup is unavailable.
function storedContradictionIds(existing) {
  return parseFlags(existing?.risk_flags)
    .filter((f) => typeof f === 'string' && f.startsWith('contradiction:'))
    .map((f) => f.slice('contradiction:'.length));
}

async function getOpenContradictionIdsFor(entryId, existing = null) {
  if (!entryId) return [];
  try {
    const rows = await db('knowledge_contradictions')
      .where({ wiki_entry_id: entryId })
      .whereNotIn('status', ['resolved', 'dismissed'])
      .select('id');
    return rows.map((r) => r.id);
  } catch (err) {
    // Fail CLOSED: an unavailable lookup must not clear an existing gate and
    // silently trust the page. Fall back to the identities already recorded
    // in the page's risk flags — a genuinely absent knowledge_contradictions
    // table yields no stored ids (correctly []), while a transient query
    // failure preserves the current contradiction gate untouched.
    logger.error(`[agronomic-wiki] open-contradiction lookup failed for entry ${entryId}: ${err.message}`);
    return storedContradictionIds(existing);
  }
}

// The wiki page is the source of truth for trust, but syncToClaudeopedia
// mirrors pages into knowledge_base rows that EVERY KB reader (search,
// assistant search, wiki Q&A) serves by status alone. Flip the mirrored
// copy's status whenever the source page's trusted-ness changes, so the
// shared KB layer inherits the gate without per-reader predicates.
async function syncKbCopyTrust(entryId, trusted) {
  if (!entryId) return;
  try {
    // Both gates: `status` (bridge/search readers) AND the `active` boolean
    // (wiki-qa query/search/list/lookup filter on active alone).
    await db('knowledge_base')
      .where({ wiki_entry_id: entryId, source: 'wiki-sync' })
      .update({ status: trusted ? 'active' : 'flagged', active: trusted, updated_at: new Date() });
  } catch (err) {
    // Only an absent knowledge_base table (42P01, fresh install) is benign.
    if (err?.code === '42P01') return;
    // A GATING update gets one immediate retry — by this point the source
    // page is already written untrusted, so every transient failure here
    // means a stale active mirror until some later resync.
    if (!trusted) {
      try {
        await db('knowledge_base')
          .where({ wiki_entry_id: entryId, source: 'wiki-sync' })
          .update({ status: 'flagged', active: false, updated_at: new Date() });
        logger.warn(`[agronomic-wiki] KB mirror gating for entry ${entryId} succeeded on retry`);
        return;
      } catch (retryErr) {
        err = retryErr;
      }
    }
    logger.error(`[agronomic-wiki] KB mirror trust sync failed for entry ${entryId} (trusted=${trusted}): ${err.message}`);
    // A failed GATING update leaves a stale active mirror agent-visible —
    // that must surface to the caller, not read as success. A failed
    // re-trust merely keeps the mirror flagged (conservative), so log only.
    if (!trusted) throw err;
  }
}

// Recompute a page's review gate from the CURRENT open-contradiction state
// and align its KB mirror. Called by the contradiction detectors right after
// inserting a new knowledge_contradictions row (trusted reads gate on the
// page's cached review_status, so an already-generated page must be flipped
// at insert time, not at its next refresh) AND by the contradiction
// resolve/dismiss route (clearing the last blocker must un-gate the page
// without waiting for a future regeneration). Pins, blocks, and sticky
// approval are honored by the shared resolver; per-id contradiction flags
// mean a genuinely NEW contradiction changes the flag set, so a stale
// approval never absorbs it.
async function recomputeEntryReviewGate(entryId, { assumeOpenIds = [] } = {}) {
  if (!entryId) return;
  try {
    const existing = await db('knowledge_entries').where({ id: entryId }).first();
    if (!existing) return;
    // assumeOpenIds: contradiction ids the caller KNOWS are open (it just
    // inserted them). The union guards the first-contradiction case — with
    // nothing recorded in risk_flags yet, a transient lookup failure would
    // otherwise resolve to "no blockers" and leave the page trusted.
    const openContradictionIds = [...new Set([
      ...(await getOpenContradictionIdsFor(entryId, existing)),
      ...assumeOpenIds.filter((id) => id != null),
    ])];
    const review = resolveReviewFields(existing, {
      confidence: existing.confidence,
      content: existing.content,
      openContradictionIds,
    });
    if (
      review.reviewStatus !== existing.review_status ||
      review.tier !== existing.review_tier ||
      !sameFlagSets(existing.risk_flags, review.flags)
    ) {
      await db('knowledge_entries').where({ id: entryId }).update({
        review_tier: review.tier,
        review_status: review.reviewStatus,
        risk_flags: JSON.stringify(review.flags),
        updated_at: new Date(),
      });
    }
    await syncKbCopyTrust(entryId, TRUSTED_STATUSES.includes(review.reviewStatus));
  } catch (err) {
    // Rethrow: detector callers just inserted the contradiction row, so
    // dedup means THIS was the only recompute that would ever run for it —
    // a swallowed failure would leave the page trusted until an unrelated
    // regeneration. Callers surface it (detector outer catches, route 500).
    logger.error(`[agronomic-wiki] recomputeEntryReviewGate failed for entry ${entryId}: ${err.message}`);
    throw err;
  }
}

async function callClaude(systemPrompt, userPrompt) {
  if (!Anthropic) {
    logger.warn('[agronomic-wiki] Anthropic SDK not available — skipping AI generation');
    return null;
  }
  try {
    const client = new Anthropic();
    const response = await createDeepMessage(client, {
      model: MODEL,
      max_tokens: 8192, // DEEP: thinking spends from max_tokens — keep headroom for the visible answer
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = response.content?.[0]?.text || '';
    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    return { text, tokens, model: response.model || MODEL };
  } catch (err) {
    logger.error(`[agronomic-wiki] Claude call failed: ${err.message}`);
    return null;
  }
}

async function logUpdate(action, entrySlug, description, opts = {}) {
  try {
    await db('knowledge_update_log').insert({
      action,
      entry_slug: entrySlug,
      description,
      trigger_type: opts.triggerType || null,
      trigger_id: opts.triggerId || null,
      model_used: opts.model || null,
      tokens_used: opts.tokens || null,
    });
  } catch (err) {
    logger.error(`[agronomic-wiki] Failed to log update: ${err.message}`);
  }
}

// Treatment-day weather onto an outcome row (single reading, not a window
// average — the column names predate this writer; rainfall is the station's
// 7-day accumulation). Prefer the post-assessment's persisted FAWN snapshot
// (no network); fall back to a current fetch, which approximates application
// conditions since the link runs on treatment day. Enrichment only — never
// blocks or fails the link; a transient failure logs and leaves the weather
// columns null for the early-return retry path to pick up (codex P2 r4).
async function backfillOutcomeWeather(outcome, post, treatmentDate) {
  try {
    const { etCalendarDayOf, etDateString, parseETDateTime } = require('../utils/datetime-et');
    // The post-assessment's snapshot only represents application-day
    // conditions when the assessment happened ON the treatment day —
    // the legacy pairing accepts assessments up to 60 days later. And
    // even a same-day assessment can carry a STALE snapshot:
    // attachWeather persists fawn-weather's cached _lastSnapshot on
    // fetch failure, with no age limit. So the snapshot's own recorded
    // moment (observation_time when present, else fetch timestamp)
    // must ALSO land on the treatment day; missing or unparseable
    // snapshot metadata fails closed.
    // Shared freshness bound (≤6h): both the persisted snapshot and the
    // getCurrent() fallback can carry fawn-weather's age-unlimited
    // cached _lastSnapshot, and even a same-ET-day snapshot from just
    // after midnight can be 20+ hours from the application.
    const FRESH_MS = 6 * 60 * 60 * 1000;
    const parseMoment = (value) => {
      if (value == null) return null;
      const parsed = parseETDateTime(String(value));
      const ms = parsed?.getTime?.();
      return Number.isFinite(ms) ? parsed : null;
    };
    // Age must be NON-NEGATIVE as well as under the window — a future
    // observation_time (clock-skewed or malformed station data) would
    // otherwise pass every "recent" check forever.
    const withinFreshWindow = (parsed) => {
      const age = Date.now() - parsed.getTime();
      return age >= 0 && age < FRESH_MS;
    };
    const postIsTreatmentDay = etCalendarDayOf(post.service_date) === etCalendarDayOf(treatmentDate);
    let snapshotUsable = false;
    if (postIsTreatmentDay && post.fawn_snapshot) {
      try {
        const snap = typeof post.fawn_snapshot === 'string' ? JSON.parse(post.fawn_snapshot) : post.fawn_snapshot;
        const parsed = parseMoment(snap?.observation_time ?? snap?.timestamp);
        snapshotUsable = parsed !== null
          && etDateString(parsed) === etCalendarDayOf(treatmentDate)
          && withinFreshWindow(parsed);
      } catch { /* unparseable snapshot fails closed */ }
    }
    let weather = snapshotUsable
      && (post.fawn_temp_f != null || post.fawn_humidity_pct != null || post.fawn_rainfall_7d != null)
      ? { temp_f: post.fawn_temp_f, humidity_pct: post.fawn_humidity_pct, rainfall_in: post.fawn_rainfall_7d }
      : null;
    // Current-conditions fallback ONLY when the treatment is actually
    // today (ET): a late confirm or resumed completion can link a
    // historical treatment, and stamping today's weather onto it would
    // permanently misattribute the application conditions.
    // etCalendarDayOf, not etDateString: service_date is a pg DATE
    // materialized at UTC midnight — the ET wall clock would shift it
    // to the previous day and the same-day check would never pass.
    if (!weather && etCalendarDayOf(treatmentDate) === etDateString()) {
      const fawn = await require('./fawn-weather').getCurrent();
      // Same ≤6h bound as the persisted-snapshot path above. The
      // STATION's observation_time is authoritative when present
      // (naive strings are ET wall-clock — parseETDateTime handles
      // that); fetch-time `timestamp` is only a cache-age fallback.
      // Present-but-unparseable observation_time fails closed.
      const freshMoment = (value) => {
        if (value == null) return null;
        const parsed = parseMoment(value);
        return parsed !== null ? withinFreshWindow(parsed) : false;
      };
      const obsFresh = freshMoment(fawn?.observation_time);
      const fresh = obsFresh !== null ? obsFresh : freshMoment(fawn?.timestamp) === true;
      if (fawn && fawn.station !== 'unavailable' && fresh) weather = fawn;
    }
    if (weather) {
      await db('treatment_outcomes').where({ id: outcome.id }).update({
        avg_temperature: weather.temp_f ?? null,
        avg_humidity: weather.humidity_pct ?? null,
        total_rainfall: weather.rainfall_in ?? null,
      });
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[agronomic-wiki] outcome ${outcome.id} weather backfill failed: ${err.message}`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// CORE METHODS
// ══════════════════════════════════════════════════════════════

const AgronomicWiki = {

  // ────────────────────────────────────────────────────────────
  // linkTreatmentOutcome — called after an assessment is confirmed
  // ────────────────────────────────────────────────────────────
  async linkTreatmentOutcome(serviceRecordId) {
    try {
      if (!serviceRecordId) {
        logger.warn('[agronomic-wiki] linkTreatmentOutcome called without serviceRecordId');
        return null;
      }

      // Already linked?
      const existing = await db('treatment_outcomes')
        .where({ service_record_id: serviceRecordId })
        .first();
      if (existing) {
        logger.info(`[agronomic-wiki] treatment_outcome already exists for service_record ${serviceRecordId}`);
        // Weather enrichment is fire-and-forget below, so a transient FAWN
        // fetch or update failure would otherwise be abandoned permanently —
        // nothing else writes these columns. Retry when the existing row
        // still has no weather at all (codex P2 r4); the helper's same-day
        // freshness gates still decide whether any value is usable, so a
        // late retry fails closed rather than stamping wrong-day conditions.
        if (existing.avg_temperature == null && existing.avg_humidity == null && existing.total_rainfall == null) {
          setImmediate(async () => {
            try {
              const existingPost = existing.post_assessment_id
                ? await db('lawn_assessments').where({ id: existing.post_assessment_id }).first()
                : null;
              if (existingPost) await backfillOutcomeWeather(existing, existingPost, existing.treatment_date);
            } catch (err) {
              logger.warn(`[agronomic-wiki] outcome ${existing.id} weather retry failed: ${err.message}`);
            }
          });
        }
        return existing;
      }

      // 1. Find the service record (the treatment)
      const sr = await db('service_records').where({ id: serviceRecordId }).first();
      if (!sr) {
        logger.warn(`[agronomic-wiki] service_record ${serviceRecordId} not found`);
        return null;
      }

      const customerId = sr.customer_id;
      const treatmentDate = sr.service_date;

      // 2. Find the post-assessment. Prefer the assessment explicitly
      // captured for this scheduled service/record, then fall back to
      // the legacy date-based pairing.
      let postAssessment = null;
      if (sr.scheduled_service_id) {
        postAssessment = await db('lawn_assessments')
          .where({
            customer_id: customerId,
            confirmed_by_tech: true,
            service_id: sr.scheduled_service_id,
          })
          .orderByRaw('confirmed_at DESC NULLS LAST')
          .orderBy('created_at', 'desc')
          .first();
      }
      if (!postAssessment) {
        const postWindowEnd = daysFrom(treatmentDate, POST_ASSESSMENT_MAX_DAYS);
        postAssessment = await db('lawn_assessments')
          .where({ customer_id: customerId, confirmed_by_tech: true })
          .where(function () {
            this.where({ service_record_id: serviceRecordId })
              .orWhere(function () {
                this.where('service_date', '>=', treatmentDate)
                  .andWhere('service_date', '<=', postWindowEnd);
              });
          })
          .orderByRaw('CASE WHEN service_record_id = ? THEN 0 ELSE 1 END', [serviceRecordId])
          .orderBy('service_date', 'asc')
          .first();
      }

      if (!postAssessment) {
        logger.info(`[agronomic-wiki] No post-assessment found for service_record ${serviceRecordId}`);
        return null;
      }

      // 3. Find the pre-assessment — last confirmed assessment BEFORE the
      // treatment, bounded so an unrelated assessment from a prior program
      // year can't produce a bogus delta.
      const preAssessment = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .where('service_date', '<', treatmentDate)
        .where('service_date', '>=', daysFrom(treatmentDate, -PRE_ASSESSMENT_MAX_AGE_DAYS))
        .orderBy('service_date', 'desc')
        .first();

      // 4. Gather products applied
      let productsApplied = [];
      try {
        const products = await db('service_products')
          .where({ service_record_id: serviceRecordId });
        productsApplied = products.map((p) => ({
          name: p.product_name,
          rate: p.application_rate,
          unit: p.rate_unit,
          method: p.application_method || null,
          area: p.application_area || null,
        }));
      } catch { /* service_products table may not exist */ }

      // 5. Gather property context. Grass type / track / sun / irrigation
      // live on customer_turf_profiles, not customers.
      const customer = await db('customers').where({ id: customerId }).first();
      const grassContext = await loadCustomerGrassContext(customerId);

      // treatment_outcomes.irrigation_system is a boolean ("has an automatic
      // irrigation system"); the turf-profile source is a 4-value enum.
      const irrigationHasSystem = irrigationTypeHasSystem(grassContext.irrigationSystem);

      // 6. Calculate deltas
      const pre = preAssessment || {};
      const post = postAssessment;
      const delta = (field) => {
        const preVal = pre[field];
        const postVal = post[field];
        if (preVal != null && postVal != null) return postVal - preVal;
        return null;
      };

      const daysBetween = preAssessment
        ? Math.round((new Date(post.service_date) - new Date(pre.service_date)) / (1000 * 60 * 60 * 24))
        : null;

      const month = new Date(treatmentDate).getMonth() + 1;

      // 7. Insert treatment_outcome
      const [outcome] = await db('treatment_outcomes').insert({
        customer_id: customerId,
        service_record_id: serviceRecordId,
        treatment_date: treatmentDate,
        service_type: sr.service_type || null,
        grass_track: grassContext.trackKey || null,
        visit_number: sr.visit_number || null,
        products_applied: JSON.stringify(productsApplied),

        pre_assessment_id: preAssessment?.id || null,
        pre_assessment_date: preAssessment?.service_date || null,
        pre_turf_density: pre.turf_density ?? null,
        pre_weed_suppression: pre.weed_suppression ?? null,
        pre_color_health: pre.color_health ?? null,
        pre_fungus_control: pre.fungus_control ?? null,
        pre_thatch_level: pre.thatch_level ?? null,

        post_assessment_id: post.id,
        post_assessment_date: post.service_date,
        post_turf_density: post.turf_density,
        post_weed_suppression: post.weed_suppression,
        post_color_health: post.color_health,
        post_fungus_control: post.fungus_control,
        post_thatch_level: post.thatch_level,

        delta_turf_density: delta('turf_density'),
        delta_weed_suppression: delta('weed_suppression'),
        delta_color_health: delta('color_health'),
        delta_fungus_control: delta('fungus_control'),
        delta_thatch_level: delta('thatch_level'),

        days_between_assessments: daysBetween,
        season: getSeason(month),

        grass_type: grassContext.grassType || null,
        property_sqft: grassContext.propertySqft || null,
        sun_exposure: grassContext.sunExposure || null,
        // No canonical source for near-water yet (not on turf profile).
        near_water: null,
        irrigation_system: irrigationHasSystem,

        satisfaction_rating: null,
      }).returning('*');

      await logUpdate('ingest', null, `Linked treatment outcome for service_record ${serviceRecordId}`, {
        triggerType: 'assessment_confirmed',
        triggerId: serviceRecordId,
      });

      // 8. Queue weather backfill + wiki page updates (fire-and-forget so we
      // don't block the confirm — FAWN's external fetch has a 3.5s timeout
      // and must never sit on the confirmation request path)
      setImmediate(async () => {
        // Weather enrichment (see backfillOutcomeWeather) — never blocks the
        // link; a transient failure leaves the columns null and the
        // early-return path above retries on the next link attempt.
        await backfillOutcomeWeather(outcome, post, treatmentDate);
        try {
          // Update product pages
          for (const p of productsApplied) {
            if (p.name) await AgronomicWiki.updateProductPage(p.name);
          }
          // Update track page
          if (outcome.grass_track) {
            await AgronomicWiki.updateTrackPage(outcome.grass_track);
          }
          // Update seasonal page
          await AgronomicWiki.updateSeasonalPage(month);
        } catch (err) {
          logger.error(`[agronomic-wiki] Background wiki update failed: ${err.message}`);
        }
      });

      logger.info(`[agronomic-wiki] Created treatment_outcome ${outcome.id} for customer ${customerId}`);
      return outcome;

    } catch (err) {
      logger.error(`[agronomic-wiki] linkTreatmentOutcome failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // sweepMissingOutcomeWeather — hourly retry for weather enrichment.
  // The confirm-time enrichment is fire-and-forget and its only callers
  // (assessment confirm, Complete Service) link each service record ONCE —
  // a transient FAWN or update failure on that first attempt has no later
  // trigger, so nothing would ever write avg_temperature/avg_humidity/
  // total_rainfall (codex P2 r5). Sweep recent outcomes still missing ALL
  // weather fields and re-run the backfill; its same-day/≤6h freshness
  // gates fail closed, so rows past the window simply age out instead of
  // getting wrong-day conditions stamped.
  // ────────────────────────────────────────────────────────────
  // limit is a runaway ceiling far above a real day's visit volume, not a
  // page: the eligible window is a single ET day, so the whole set fits in
  // one pass and permanently-unenrichable rows (deleted assessment,
  // unusable snapshot) can never crowd retryable ones out of the batch.
  async sweepMissingOutcomeWeather({ limit = 200 } = {}) {
    const stats = { checked: 0, enriched: 0 };
    try {
      // Enrichment can only succeed on the treatment's own ET day — bound
      // the scan to yesterday's ET calendar date. treatment_date is a pg
      // DATE, so compare against an ET date string, not an instant: a UTC
      // instant cutoff lands after ET midnight in the evening and would
      // skip every current-day outcome after 8 PM ET. Over-selecting is
      // safe because the backfill's gates fail closed.
      const { etDateString: etDay, addETDays: addDays } = require('../utils/datetime-et');
      const rows = await db('treatment_outcomes')
        .whereNull('avg_temperature')
        .whereNull('avg_humidity')
        .whereNull('total_rainfall')
        .whereNotNull('post_assessment_id')
        .where('treatment_date', '>=', etDay(addDays(new Date(), -1)))
        .orderBy('treatment_date', 'desc')
        .limit(limit);
      for (const row of rows) {
        stats.checked++;
        const post = await db('lawn_assessments').where({ id: row.post_assessment_id }).first();
        if (!post) continue;
        if (await backfillOutcomeWeather(row, post, row.treatment_date)) stats.enriched++;
      }
      return stats;
    } catch (err) {
      logger.error(`[agronomic-wiki] weather backfill sweep failed: ${err.message}`);
      return { ...stats, error: err.message };
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateProductPage — aggregate outcomes for a product, generate wiki page
  // ────────────────────────────────────────────────────────────
  async updateProductPage(productName, { rethrow = false, withState = false } = {}) {
    try {
      // One page per catalog product: resolve the applied-product string to
      // its canonical catalog name and aggregate outcomes across every known
      // name variant, so vendor-listing spellings don't split the data.
      const { canonicalName, variants } = await resolveCanonicalProduct(productName);
      const slug = `product/${slugify(canonicalName)}`;

      const outcomes = await db('treatment_outcomes')
        .where(function () {
          for (const variant of variants) {
            this.orWhereRaw("products_applied::text ILIKE ? ESCAPE '\\'", [`%${escapeLike(variant)}%`]);
          }
        })
        .orderBy('treatment_date', 'desc');

      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for product ${productName}`);
        return withState ? { entry: null, writeState: 'no_data' } : null;
      }

      // Aggregate stats
      const stats = aggregateOutcomes(outcomes);
      const data = {
        productName: canonicalName,
        stats,
        outcomes: outcomes.slice(0, 50),
        totalOutcomeCount: outcomes.length,
        allOutcomeIds: outcomes.map((o) => o.id),
      };

      const result = await AgronomicWiki.generatePage(slug, 'product', data, `Product: ${canonicalName}`);
      const entry = result?.entry || null;

      // Fold variant-named duplicate pages into the canonical page. Only when
      // this call actually wrote fresh content ('generated') or verified the
      // canonical fingerprint already covers the variant-inclusive outcome set
      // ('skipped'). A failed refresh or a stub must never absorb a variant
      // page that may hold the only real analysis.
      const mergeSafe = result && ['generated', 'skipped'].includes(result.writeState)
        && entry && !entry.content?.includes('*Pending AI generation');
      if (mergeSafe) {
        await mergeVariantProductPages(entry, variants, slug);

        // The merge re-points variant contradictions onto the canonical page —
        // a page stamped trusted moments ago may have inherited an open
        // contradiction. Re-resolve so the gate reflects the post-merge state.
        const inheritedContradictionIds = await getOpenContradictionIdsFor(entry.id, entry);
        if (inheritedContradictionIds.length) {
          const review = resolveReviewFields(entry, {
            confidence: entry.confidence,
            content: entry.content,
            openContradictionIds: inheritedContradictionIds,
          });
          // Flag-set changes must persist even when tier/status don't move
          // (page already red/pending for another reason): the inherited
          // contradiction's identity has to be part of any later approval's
          // sticky snapshot.
          if (
            review.reviewStatus !== entry.review_status ||
            review.tier !== entry.review_tier ||
            !sameFlagSets(entry.risk_flags, review.flags)
          ) {
            await db('knowledge_entries')
              .where({ id: entry.id })
              .update({
                review_tier: review.tier,
                review_status: review.reviewStatus,
                risk_flags: JSON.stringify(review.flags),
                updated_at: new Date(),
              });
            Object.assign(entry, { review_tier: review.tier, review_status: review.reviewStatus, risk_flags: review.flags });
          }
        }

        // Unconditional: the merge may have re-pointed variant mirrors (with
        // the variant's old active/status) onto this entry — align every
        // mirror with the canonical page's CURRENT trust, whatever gated it.
        await syncKbCopyTrust(entry.id, TRUSTED_STATUSES.includes(entry.review_status));
      }

      if (withState) return { entry, writeState: result?.writeState || 'failed' };
      return entry;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateProductPage failed for ${productName}: ${err.message}`);
      if (rethrow) throw err;
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateConditionPage — aggregate outcomes for a pest/disease/weed condition
  // ────────────────────────────────────────────────────────────
  async updateConditionPage(conditionName, { rethrow = false, withState = false } = {}) {
    try {
      const slug = `condition/${slugify(conditionName)}`;

      // Find assessments mentioning this condition
      const assessments = await db('lawn_assessments')
        .where('observations', 'ilike', `%${conditionName}%`)
        .orderBy('service_date', 'desc')
        .limit(100);

      const customerIds = [...new Set(assessments.map((a) => a.customer_id))];

      // Find treatment outcomes for these customers
      const outcomes = customerIds.length
        ? await db('treatment_outcomes')
            .whereIn('customer_id', customerIds)
            .orderBy('treatment_date', 'desc')
            .limit(100)
        : [];

      const stats = aggregateOutcomes(outcomes);
      const data = {
        conditionName,
        stats,
        assessmentCount: assessments.length,
        outcomes: outcomes.slice(0, 50),
        totalOutcomeCount: outcomes.length,
        // Assessment-only condition pages (no outcomes yet) fingerprint on
        // the matching assessment ids — an empty id set would make the skip
        // guard blind to a changed assessment set with an equal count.
        allOutcomeIds: outcomes.length ? outcomes.map((o) => o.id) : assessments.map((a) => a.id),
      };

      const result = await AgronomicWiki.generatePage(slug, 'condition', data, `Condition: ${conditionName}`);
      if (withState) return { entry: result?.entry || null, writeState: result?.writeState || 'failed' };
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateConditionPage failed for ${conditionName}: ${err.message}`);
      if (rethrow) throw err;
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateTrackPage — aggregate performance across all customers on a track
  // ────────────────────────────────────────────────────────────
  async updateTrackPage(trackId, { rethrow = false, withState = false } = {}) {
    try {
      const slug = `track/${slugify(trackId)}`;

      const outcomes = await db('treatment_outcomes')
        .where({ grass_track: trackId })
        .orderBy('visit_number', 'asc')
        .orderBy('treatment_date', 'desc');

      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for track ${trackId}`);
        return withState ? { entry: null, writeState: 'no_data' } : null;
      }

      const stats = aggregateOutcomes(outcomes);
      const customerCount = new Set(outcomes.map((o) => o.customer_id)).size;
      const data = {
        trackId,
        stats,
        customerCount,
        outcomes: outcomes.slice(0, 50),
        totalOutcomeCount: outcomes.length,
        allOutcomeIds: outcomes.map((o) => o.id),
      };

      const result = await AgronomicWiki.generatePage(slug, 'track', data, `Track ${trackId} Performance`);
      if (withState) return { entry: result?.entry || null, writeState: result?.writeState || 'failed' };
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateTrackPage failed for ${trackId}: ${err.message}`);
      if (rethrow) throw err;
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateSeasonalPage — aggregate what happened this month
  // ────────────────────────────────────────────────────────────
  async updateSeasonalPage(month, { rethrow = false, withState = false } = {}) {
    try {
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const monthName = monthNames[month - 1] || `Month-${month}`;
      const slug = `seasonal/${slugify(monthName)}`;

      const outcomes = await db('treatment_outcomes')
        .whereRaw("EXTRACT(MONTH FROM treatment_date) = ?", [month])
        .orderBy('treatment_date', 'desc');

      // Match product/track behavior: no outcomes → no page. Generating from
      // zero data burns an AI call to write a page that can only say
      // "no data yet". Any page that already exists for a zero-outcome month
      // is definitionally filler (the query spans all years) — prune it so it
      // can't clog the stale-refresh budget or surface in agent reads.
      if (!outcomes.length) {
        let pruned = 0;
        try {
          pruned = await db('knowledge_entries')
            .where({ slug, category: 'seasonal' })
            .del();
        } catch (err) {
          // A failed prune leaves the stale filler page agent-readable —
          // reporting 'no_data' here would let weeklyRefresh write its
          // six-day success marker over it, deferring the retry a whole
          // week (codex P2 r5). Fail the leg instead: rethrow under
          // REFRESH_OPTS, writeState 'failed' otherwise — either way the
          // weekly marker is withheld and tomorrow's run retries.
          logger.error(`[agronomic-wiki] Failed to prune empty seasonal page ${slug}: ${err.message}`);
          if (rethrow) throw err;
          return withState ? { entry: null, writeState: 'failed' } : null;
        }
        if (pruned) {
          await logUpdate('prune', slug, `Pruned zero-outcome seasonal page for ${monthName}`, {
            triggerType: 'wiki_generation',
          });
        }
        logger.info(`[agronomic-wiki] No outcomes found for month ${month} — skipping seasonal page`);
        return withState ? { entry: null, writeState: 'no_data' } : null;
      }

      const stats = aggregateOutcomes(outcomes);
      const data = {
        month,
        monthName,
        stats,
        outcomes: outcomes.slice(0, 50),
        totalOutcomeCount: outcomes.length,
        allOutcomeIds: outcomes.map((o) => o.id),
      };

      const result = await AgronomicWiki.generatePage(slug, 'seasonal', data, `${monthName} — Seasonal Intelligence`);
      if (withState) return { entry: result?.entry || null, writeState: result?.writeState || 'failed' };
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateSeasonalPage failed for month ${month}: ${err.message}`);
      if (rethrow) throw err;
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // generatePage — call Claude to generate/update a wiki page.
  // Returns { entry, writeState } where writeState is one of
  // 'generated' (fresh AI content written), 'skipped' (data unchanged),
  // 'failed' (AI call failed, existing preserved), 'stub' (placeholder
  // created for a new page) — or null on error. Callers that only need
  // the page should unwrap .entry.
  // ────────────────────────────────────────────────────────────
  async generatePage(slug, category, data, title) {
    try {
      // Check for existing page
      const existing = await db('knowledge_entries').where({ slug }).first();

      // Fingerprint the FULL outcome set (callers slice data.outcomes to 50
      // for the prompt, but stats aggregate everything — a change outside the
      // newest 50 must still invalidate the skip).
      // || (not ??) so a zero outcome count falls through to assessmentCount —
      // condition pages can be assessment-only, and a hard 0 would freeze
      // their skip fingerprint forever.
      const dataPointCount = data.totalOutcomeCount || data.outcomes?.length || data.assessmentCount || 0;
      const confidence = confidenceLevel(dataPointCount);
      // Full id set, uncapped — a truncated fingerprint is blind to changes
      // past the cap while count stays equal (delete+backfill, alias remap).
      const sourceIds = data.allOutcomeIds || (data.outcomes || []).map((o) => o.id);

      // Skip regeneration when the underlying data hasn't changed — the AI
      // pass would just rewrite the same page. Placeholder stubs are always
      // retried. last_data_update advances so the page doesn't get re-marked
      // stale (and re-skipped) on every subsequent refresh: it records "data
      // verified current", which is what this branch just did.
      const openContradictionIds = await getOpenContradictionIdsFor(existing?.id, existing);

      if (
        existing &&
        !existing.content.includes('*Pending AI generation') &&
        existing.data_point_count === dataPointCount &&
        sameSourceIds(existing.source_treatment_ids, sourceIds)
      ) {
        // Data unchanged, but the review state may not be: a contradiction
        // that appeared since the last write must re-gate the page here too.
        const review = resolveReviewFields(existing, { confidence, content: existing.content, openContradictionIds });
        await db('knowledge_entries')
          .where({ id: existing.id })
          .update({
            stale_flag: false,
            last_data_update: new Date(),
            updated_at: new Date(),
            review_tier: review.tier,
            review_status: review.reviewStatus,
            risk_flags: JSON.stringify(review.flags),
          });
        await syncKbCopyTrust(existing.id, TRUSTED_STATUSES.includes(review.reviewStatus));
        await logUpdate('skip', slug, `Skipped ${category} page: ${title} — no new data since last generation (${dataPointCount} data points)`, {
          triggerType: 'wiki_generation',
        });
        logger.info(`[agronomic-wiki] Skipped page ${slug} — data unchanged (${dataPointCount} pts)`);
        // Merge the review fields just written — callers act on the returned
        // entry's trust (post-merge mirror alignment), and the stale pre-update
        // row could re-flag a mirror this branch just reactivated.
        return {
          entry: {
            ...existing,
            review_tier: review.tier,
            review_status: review.reviewStatus,
            risk_flags: JSON.stringify(review.flags),
          },
          writeState: 'skipped',
        };
      }

      const systemPrompt = `You are maintaining an agronomic knowledge wiki for Waves Pest Control in Southwest Florida. You write technically accurate, data-driven content based on real treatment outcomes. Never fabricate data. Only make claims supported by the provided data points. When data is limited, say so explicitly. When data contradicts existing claims, flag it clearly. Write in markdown format.

Frame every finding as internal field intelligence, never as label authority: do not present application rates, intervals, or restrictions as official guidance — the product label and local ordinances are always the authority. Include this line verbatim immediately after the top heading: *Field intelligence from Waves treatment outcomes — not label guidance.*`;

      const existingContent = existing ? `\n\nCurrent wiki page content:\n${existing.content}` : '';

      const userPrompt = `${title}

Category: ${category}
Data points: ${dataPointCount}
Confidence: ${confidence}
${existingContent}

Aggregated data:
${JSON.stringify(data.stats || {}, null, 2)}

Recent treatment outcomes (up to 50):
${JSON.stringify((data.outcomes || []).map((o) => ({
  date: o.treatment_date,
  track: o.grass_track,
  season: o.season,
  delta_turf: o.delta_turf_density,
  delta_weed: o.delta_weed_suppression,
  delta_color: o.delta_color_health,
  delta_fungus: o.delta_fungus_control,
  delta_thatch: o.delta_thatch_level,
  days: o.days_between_assessments,
  grass: o.grass_type,
  products: o.products_applied,
})), null, 2)}

Task: ${existing ? 'Update this wiki page incorporating the new data. Preserve existing content that is still supported. Update statistics. Flag any contradictions.' : 'Generate a new wiki page from this data.'} Return the complete markdown page content.`;

      const result = await callClaude(systemPrompt, userPrompt);

      // A failed AI call must never clobber an existing page with the
      // placeholder stub — keep the current content and surface the failure
      // in the update log instead.
      if (!result?.text?.trim() && existing) {
        // Content is preserved, but the review state must still advance — a
        // contradiction that appeared since the last write re-gates the page
        // even when the refresh itself failed.
        // Classify with the FRESH confidence — the new source set may have
        // shrunk below the trust threshold even though this refresh failed.
        const review = resolveReviewFields(existing, { confidence, content: existing.content, openContradictionIds });
        // A preserved page may itself still be the placeholder stub (stubs are
        // always retried, so a retry that fails lands here) — a stub is never
        // trusted, whatever its data-point confidence.
        if (existing.content.includes('*Pending AI generation')) {
          review.tier = 'red';
          review.flags = [...new Set([...review.flags, 'generation_stub'])];
          if (review.reviewStatus !== 'blocked') review.reviewStatus = 'pending_review';
        }
        try {
          await db('knowledge_entries')
            .where({ id: existing.id })
            .update({
              review_tier: review.tier,
              review_status: review.reviewStatus,
              risk_flags: JSON.stringify(review.flags),
              updated_at: new Date(),
            });
          await syncKbCopyTrust(existing.id, TRUSTED_STATUSES.includes(review.reviewStatus));
        } catch (reviewErr) {
          logger.error(`[agronomic-wiki] Failed to update review state for ${slug}: ${reviewErr.message}`);
          // If the target state is UNTRUSTED, a swallowed failure would
          // report 'failed' as though the gate was applied while the page
          // or its mirror stays trusted — fail the whole call instead.
          if (!TRUSTED_STATUSES.includes(review.reviewStatus)) throw reviewErr;
        }
        await logUpdate('error', slug, `Generation failed for ${category} page: ${title} — existing content preserved`, {
          triggerType: 'wiki_generation',
        });
        logger.warn(`[agronomic-wiki] Generation failed for ${slug} — existing content preserved`);
        return {
          entry: {
            ...existing,
            review_tier: review.tier,
            review_status: review.reviewStatus,
            risk_flags: JSON.stringify(review.flags),
          },
          writeState: 'failed',
        };
      }

      const content = result?.text?.trim()
        ? result.text
        : `# ${title}\n\n*Pending AI generation — ${dataPointCount} data points available.*`;

      // Classify the fresh content into a review tier (open contradictions
      // force red regardless of confidence; pins/blocks/sticky approval are
      // handled inside the shared resolver). A placeholder stub is never
      // trusted, whatever its data-point confidence — 'Pending AI generation'
      // must not reach estimates as field intelligence.
      let { tier, flags, reviewStatus } = resolveReviewFields(existing, { confidence, content, openContradictionIds });
      if (!result?.text?.trim()) {
        tier = 'red';
        flags = [...new Set([...flags, 'generation_stub'])];
        if (reviewStatus !== 'blocked') reviewStatus = 'pending_review';
      }

      const entryData = {
        slug,
        category,
        title: title || slug,
        content,
        summary: extractSummary(content),
        data_point_count: dataPointCount,
        confidence,
        last_data_update: new Date(),
        stale_flag: false,
        source_treatment_ids: JSON.stringify(sourceIds),
        review_tier: tier,
        review_status: reviewStatus,
        risk_flags: JSON.stringify(flags),
      };

      let entry;
      if (existing) {
        [entry] = await db('knowledge_entries')
          .where({ id: existing.id })
          .update({ ...entryData, updated_at: new Date() })
          .returning('*');
      } else {
        [entry] = await db('knowledge_entries')
          .insert(entryData)
          .returning('*');
      }

      await logUpdate(
        existing ? 'update' : 'ingest',
        slug,
        `${existing ? 'Updated' : 'Created'} ${category} page: ${title} (${dataPointCount} data points, ${confidence} confidence, tier ${tier}${reviewStatus === 'pending_review' ? ' — awaiting review' : ''})`,
        {
          triggerType: 'wiki_generation',
          model: result?.model || null,
          tokens: result?.tokens || null,
        },
      );

      await syncKbCopyTrust(entry?.id, TRUSTED_STATUSES.includes(reviewStatus));

      logger.info(`[agronomic-wiki] ${existing ? 'Updated' : 'Created'} page: ${slug} (${dataPointCount} pts, ${confidence})`);
      return { entry, writeState: result?.text?.trim() ? 'generated' : 'stub' };

    } catch (err) {
      logger.error(`[agronomic-wiki] generatePage failed for ${slug}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // searchWiki — full-text search across wiki pages
  // ────────────────────────────────────────────────────────────
  async searchWiki(query, options = {}) {
    if (!query || !query.trim()) return [];
    const term = `%${query.trim().toLowerCase()}%`;
    let q = db('knowledge_entries')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term)
          .orWhere('summary', 'ilike', term)
          .orWhereRaw("tags::text ILIKE ?", [term]);
      });
    // Agent-facing callers pass trustedOnly — red pages awaiting review (or
    // human-blocked) never feed an agent.
    if (options.trustedOnly) {
      q = q.whereIn('review_status', TRUSTED_STATUSES);
    }
    return q
      .orderByRaw("CASE WHEN title ILIKE ? THEN 0 WHEN summary ILIKE ? THEN 1 ELSE 2 END", [term, term])
      .orderBy('data_point_count', 'desc')
      .limit(30)
      .select('id', 'slug', 'category', 'title', 'summary', 'data_point_count', 'confidence', 'tags', 'last_data_update', 'stale_flag', 'review_tier', 'review_status', 'risk_flags');
  },

  // ────────────────────────────────────────────────────────────
  // getPage — get a single page by slug
  // ────────────────────────────────────────────────────────────
  async getPage(slug) {
    return db('knowledge_entries').where({ slug }).first();
  },

  // ────────────────────────────────────────────────────────────
  // listPages — list pages filtered by category
  // ────────────────────────────────────────────────────────────
  async listPages(category, options = {}) {
    let query = db('knowledge_entries')
      .select('id', 'slug', 'category', 'title', 'summary', 'data_point_count', 'confidence', 'tags', 'last_data_update', 'stale_flag', 'created_at', 'updated_at', 'review_tier', 'review_status', 'risk_flags', 'last_human_review', 'reviewed_by');

    if (category) {
      query = query.where({ category });
    }

    if (options.staleOnly) {
      query = query.where({ stale_flag: true });
    }

    const orderBy = options.orderBy || 'updated_at';
    const orderDir = options.orderDir || 'desc';
    query = query.orderBy(orderBy, orderDir);

    const limit = Math.min(options.limit || 100, 500);
    const offset = options.offset || 0;
    query = query.limit(limit).offset(offset);

    return query;
  },

  // ────────────────────────────────────────────────────────────
  // getStats — dashboard stats
  // ────────────────────────────────────────────────────────────
  async getStats() {
    const [totalRow] = await db('knowledge_entries').count('id as count');
    const total = parseInt(totalRow.count) || 0;

    const confidenceDist = await db('knowledge_entries')
      .select('confidence')
      .count('id as count')
      .groupBy('confidence');

    const [staleRow] = await db('knowledge_entries').where({ stale_flag: true }).count('id as count');
    const staleCount = parseInt(staleRow.count) || 0;

    const [outcomeRow] = await db('treatment_outcomes').count('id as count');
    const totalOutcomes = parseInt(outcomeRow.count) || 0;

    const categoryDist = await db('knowledge_entries')
      .select('category')
      .count('id as count')
      .groupBy('category');

    return {
      totalPages: total,
      totalOutcomes,
      staleCount,
      confidenceDistribution: confidenceDist.reduce((acc, r) => {
        acc[r.confidence] = parseInt(r.count);
        return acc;
      }, {}),
      categoryDistribution: categoryDist.reduce((acc, r) => {
        acc[r.category] = parseInt(r.count);
        return acc;
      }, {}),
    };
  },

  // ────────────────────────────────────────────────────────────
  // getLog — recent update log
  // ────────────────────────────────────────────────────────────
  async getLog(limit = 50) {
    return db('knowledge_update_log')
      .orderBy('created_at', 'desc')
      .limit(Math.min(limit, 200));
  },

  // ────────────────────────────────────────────────────────────
  // weeklyRefresh — cron job: update stale pages, generate seasonal page
  // ────────────────────────────────────────────────────────────
  async weeklyRefresh() {
    logger.info('[agronomic-wiki] Starting weekly refresh');

    try {
      // 1. Mark stale pages (last_data_update > 60 days ago)
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await db('knowledge_entries')
        .where('last_data_update', '<', sixtyDaysAgo)
        .where({ stale_flag: false })
        .update({ stale_flag: true });

      // 2. Refresh stale pages (up to 10 per run to control API costs).
      // Only categories with a refresh path — anything else would sit in the
      // stale list forever, permanently occupying refresh slots.
      const stalePages = await db('knowledge_entries')
        .where({ stale_flag: true })
        .whereIn('category', ['product', 'track', 'seasonal', 'condition'])
        .orderBy('last_data_update', 'asc')
        .limit(10);

      // Failure accounting by writeState, not by return truthiness:
      // generatePage converts its own failures into { writeState: 'failed' }
      // (LLM error, gate-write error) or 'stub' (empty generation), which
      // the plain updater return would count as refreshed. Classification:
      //   generated/skipped → refreshed; no_data → orphan page with no
      //   source outcomes (left stale, never blocks the chain);
      //   failed/stub/thrown → failed, which withholds the weekly success
      //   marker (daily retry; refreshed pages skip via the fingerprint
      //   guard) and surfaces to job_health via the returned { error }.
      let refreshed = 0;
      let failed = 0;
      let noData = 0;
      const classify = (res) => {
        if (['generated', 'skipped'].includes(res?.writeState)) refreshed++;
        else if (res?.writeState === 'no_data') noData++;
        else failed++;
      };
      const REFRESH_OPTS = { rethrow: true, withState: true };
      for (const page of stalePages) {
        try {
          if (page.category === 'product') {
            const productName = page.title.replace(/^Product:\s*/i, '');
            classify(await AgronomicWiki.updateProductPage(productName, REFRESH_OPTS));
          } else if (page.category === 'track') {
            const trackId = page.slug.replace('track/', '');
            classify(await AgronomicWiki.updateTrackPage(trackId, REFRESH_OPTS));
          } else if (page.category === 'seasonal') {
            const monthSlug = page.slug.replace('seasonal/', '');
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const monthIdx = monthNames.indexOf(monthSlug);
            if (monthIdx >= 0) {
              classify(await AgronomicWiki.updateSeasonalPage(monthIdx + 1, REFRESH_OPTS));
            }
          } else if (page.category === 'condition') {
            const conditionName = page.title.replace(/^Condition:\s*/i, '');
            classify(await AgronomicWiki.updateConditionPage(conditionName, REFRESH_OPTS));
          }
        } catch (err) {
          failed++;
          logger.error(`[agronomic-wiki] Failed to refresh page ${page.slug}: ${err.message}`);
        }
      }
      if (noData > 0) {
        logger.warn(`[agronomic-wiki] Weekly refresh: ${noData} stale page(s) have no source data (orphans) — left stale, not counted as failures`);
      }

      // 3. Generate seasonal page for current month — a failed/stub
      // generation here withholds the marker like any stale-loop failure
      // (no_data is normal early in a month with no outcomes yet).
      const currentMonth = new Date().getMonth() + 1;
      try {
        const seasonalRes = await AgronomicWiki.updateSeasonalPage(currentMonth, REFRESH_OPTS);
        if (!['generated', 'skipped', 'no_data'].includes(seasonalRes?.writeState)) failed++;
      } catch (err) {
        failed++;
        logger.error(`[agronomic-wiki] Current-month seasonal refresh failed: ${err.message}`);
      }

      if (failed > 0) {
        // Partial failure: no weekly_cron success marker — weeklyRefreshIfDue
        // retries tomorrow, and the scheduler wrapper surfaces the error to
        // job_health via the returned { error }.
        await logUpdate('error', null, `Weekly refresh: ${failed} page refresh(es) failed (${refreshed} succeeded)`, {
          triggerType: 'weekly_cron_error',
        });
        return { refreshed, failed, staleFound: stalePages.length, error: `${failed} page refresh(es) failed` };
      }

      await logUpdate('lint', null, `Weekly refresh: ${refreshed} stale pages refreshed, seasonal page updated for month ${currentMonth}`, {
        triggerType: 'weekly_cron',
      });

      logger.info(`[agronomic-wiki] Weekly refresh complete: ${refreshed} pages refreshed`);
      return { refreshed, staleFound: stalePages.length };
    } catch (err) {
      logger.error(`[agronomic-wiki] weeklyRefresh failed: ${err.message}`);
      // Log the failure so a refresh that dies is visible in the update log
      // (a silent gap here previously read the same as "cron never fired").
      // Distinct trigger_type so weeklyRefreshIfDue doesn't count a failed
      // run as done — it retries the next day.
      await logUpdate('error', null, `Weekly refresh failed: ${err.message}`, {
        triggerType: 'weekly_cron_error',
      });
      return { refreshed: 0, error: err.message };
    }
  },

  // ────────────────────────────────────────────────────────────
  // getReviewQueue — the exception surface: what actually needs judgment.
  // ────────────────────────────────────────────────────────────
  async getReviewQueue() {
    const select = ['id', 'slug', 'category', 'title', 'summary', 'data_point_count', 'confidence', 'review_tier', 'review_status', 'risk_flags', 'last_human_review', 'reviewed_by', 'human_notes', 'updated_at'];
    const pending = await db('knowledge_entries')
      .where({ review_status: 'pending_review' })
      .orderBy('updated_at', 'desc')
      .select(select);
    const blocked = await db('knowledge_entries')
      .where({ review_status: 'blocked' })
      .orderBy('updated_at', 'desc')
      .select(select);
    // Yellow pages updated in the last 7 days — the optional-review digest set
    const recentYellow = await db('knowledge_entries')
      .where({ review_tier: 'yellow' })
      .where('updated_at', '>', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      .orderBy('updated_at', 'desc')
      .limit(50)
      .select(select);
    return { pending, blocked, recentYellow };
  },

  // ────────────────────────────────────────────────────────────
  // reviewPage — human judgment on a red page: approve or block.
  // ────────────────────────────────────────────────────────────
  async reviewPage(slug, { action, notes = null, reviewedBy = 'admin' } = {}) {
    if (!['approve', 'block'].includes(action)) {
      throw new Error(`Unsupported review action: ${action}`);
    }
    const page = await db('knowledge_entries').where({ slug }).first();
    if (!page) return null;

    // A placeholder has nothing a human can meaningfully approve, and
    // 'approved' would make the mirror agent-visible with stub text —
    // reject instead of parking, so the queue shows WHY it can't clear.
    if (
      action === 'approve' &&
      ((page.content || '').includes('*Pending AI generation') || parseFlags(page.risk_flags).includes('generation_stub'))
    ) {
      const err = new Error('Cannot approve a page whose content is still pending AI generation — retry generation first');
      err.isOperational = true;
      err.statusCode = 409;
      throw err;
    }

    const reviewStatus = action === 'approve' ? 'approved' : 'blocked';
    const [updated] = await db('knowledge_entries')
      .where({ id: page.id })
      .update({
        review_status: reviewStatus,
        last_human_review: new Date(),
        reviewed_by: reviewedBy,
        human_notes: notes || page.human_notes || null,
        updated_at: new Date(),
      })
      .returning('*');

    await syncKbCopyTrust(page.id, reviewStatus === 'approved');

    await logUpdate('review', slug, `${action === 'approve' ? 'Approved' : 'Blocked'} by ${reviewedBy}${notes ? ` — ${String(notes).substring(0, 200)}` : ''}`, {
      triggerType: 'human_review',
    });
    return updated;
  },

  // ────────────────────────────────────────────────────────────
  // setTierOverride — human pins a page's tier; regeneration respects it.
  // ────────────────────────────────────────────────────────────
  async setTierOverride(slug, tier, { reviewedBy = 'admin' } = {}) {
    if (!['green', 'yellow', 'red'].includes(tier)) {
      throw new Error(`Unsupported tier: ${tier}`);
    }
    const page = await db('knowledge_entries').where({ slug }).first();
    if (!page) return null;

    // Same boundary as reviewPage approve: a green/yellow pin would set
    // review_status 'auto' and re-trust the KB mirror with placeholder
    // text. Pinning red (keep it gated) remains allowed.
    if (
      tier !== 'red' &&
      ((page.content || '').includes('*Pending AI generation') || parseFlags(page.risk_flags).includes('generation_stub'))
    ) {
      const err = new Error('Cannot pin a green/yellow tier on a page whose content is still pending AI generation — retry generation first');
      err.isOperational = true;
      err.statusCode = 409;
      throw err;
    }
    // Pins override classifier judgment, never LIVE exceptions: a green or
    // yellow pin while contradictions are open would trust the page AND
    // freeze the same identities into the pinned flags, so later recomputes
    // would see nothing new. (Lookup fails closed via stored identities.)
    if (tier !== 'red') {
      const openIds = await getOpenContradictionIdsFor(page.id, page);
      if (openIds.length) {
        const err = new Error('Cannot pin a green/yellow tier while this page has open contradictions — resolve or dismiss them first');
        err.isOperational = true;
        err.statusCode = 409;
        throw err;
      }
    }

    const flags = [...new Set([...parseFlags(page.risk_flags), 'manual_override'])];
    const [updated] = await db('knowledge_entries')
      .where({ id: page.id })
      .update({
        review_tier: tier,
        review_status: tier === 'red' ? 'pending_review' : 'auto',
        risk_flags: JSON.stringify(flags),
        last_human_review: new Date(),
        reviewed_by: reviewedBy,
        updated_at: new Date(),
      })
      .returning('*');

    await syncKbCopyTrust(page.id, tier !== 'red');

    await logUpdate('review', slug, `Tier pinned to ${tier} by ${reviewedBy}`, { triggerType: 'human_review' });
    return updated;
  },

  // ────────────────────────────────────────────────────────────
  // weeklyRefreshIfDue — daily cron entry point with a weekly guard.
  // The refresh previously ran on a single Sunday-6AM fire time; any miss
  // (restart, deploy in flight, transient error) meant a whole week of
  // silence. Running daily with a "already ran in the last 6 days" guard
  // makes the schedule self-healing while keeping the weekly cadence.
  // ────────────────────────────────────────────────────────────
  async weeklyRefreshIfDue() {
    try {
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const recentRun = await db('knowledge_update_log')
        .where({ trigger_type: 'weekly_cron' })
        .where('created_at', '>', sixDaysAgo)
        .first('id');
      if (recentRun) {
        return { skipped: true, refreshed: 0 };
      }
    } catch (err) {
      // If the guard query itself fails, running the refresh is safer than
      // never running it.
      logger.error(`[agronomic-wiki] weeklyRefreshIfDue guard query failed: ${err.message}`);
    }
    return AgronomicWiki.weeklyRefresh();
  },
};

// ══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════

// source_treatment_ids is jsonb — pg usually returns it parsed, but tolerate
// a raw string from older rows or mocks.
function sameSourceIds(existingIds, newIds) {
  let parsed = existingIds;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  if (!Array.isArray(parsed)) return false;
  if (parsed.length !== newIds.length) return false;
  const a = [...parsed].sort();
  const b = [...newIds].sort();
  return a.every((id, i) => id === b[i]);
}

// First real prose line of the page. Generated pages open with a heading and
// a run of "**Category:** ..." metadata lines — those make useless summaries
// for search results and the estimate AI context.
function extractSummary(content) {
  const line = content.split('\n').find((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return false;
    if (/^\*\*[^*]+:\*\*/.test(t)) return false; // "**Label:** value" metadata
    if (/^\*[^*].*\*$/.test(t)) return false; // full-line italics (field-intelligence banner, stubs)
    if (/^[->|]/.test(t)) return false; // blockquote callouts, list bullets, tables
    if (/^-{3,}$/.test(t)) return false; // horizontal rules
    return true;
  });
  return line?.trim()?.substring(0, 500) || '';
}

// Delete leftover product pages that were keyed on a non-canonical name
// variant, re-pointing every cross-system reference at the canonical page
// first — knowledge_bridge rows would otherwise be dropped by the ON DELETE
// CASCADE and knowledge_contradictions links nulled by SET NULL (migrations
// 20260414000018/19), silently losing curated links and contradiction
// history.
async function mergeVariantProductPages(canonicalEntry, variants, canonicalSlug) {
  for (const variant of variants) {
    const variantSlug = `product/${slugify(variant)}`;
    if (variantSlug === canonicalSlug) continue;
    try {
      const dupe = await db('knowledge_entries')
        .where({ slug: variantSlug, category: 'product' })
        .first('id', 'slug', 'kb_entry_id');
      if (!dupe) continue;

      // Carry the direct wiki→KB back-pointer if the variant was the only
      // linked page — the bridge dashboard and unified search read it.
      if (dupe.kb_entry_id && !canonicalEntry.kb_entry_id) {
        try {
          await db('knowledge_entries')
            .where({ id: canonicalEntry.id })
            .update({ kb_entry_id: dupe.kb_entry_id });
          canonicalEntry.kb_entry_id = dupe.kb_entry_id;
        } catch { /* kb_entry_id column may not exist */ }
      }

      try {
        // Wiki-sync MIRRORS of the variant still carry the variant's title
        // and content — re-pointing them would let the post-merge trust
        // alignment re-activate unreviewed duplicate text under the
        // canonical page. Delete them instead; the canonical page's own
        // mirror is (re)written by syncToClaudeopedia. (Contradiction rows
        // referencing a deleted mirror are nulled by SET NULL and keep
        // their wiki_entry_id link.)
        await db('knowledge_base')
          .where({ wiki_entry_id: dupe.id, source: 'wiki-sync' })
          .del();
        // Real KB entries merely LINKED to the variant keep their own
        // content and just follow the page identity.
        await db('knowledge_base')
          .where({ wiki_entry_id: dupe.id })
          .update({ wiki_entry_id: canonicalEntry.id });
      } catch { /* knowledge_base.wiki_entry_id column may not exist */ }

      try {
        // Move bridge rows one by one: the table has a unique
        // (kb_entry_id, wiki_entry_id, link_type) constraint, so a link the
        // canonical page already has is dropped as a duplicate instead.
        const bridgeRows = await db('knowledge_bridge')
          .where({ wiki_entry_id: dupe.id })
          .select('id', 'kb_entry_id', 'link_type');
        for (const row of bridgeRows) {
          const clash = await db('knowledge_bridge')
            .where({ wiki_entry_id: canonicalEntry.id, kb_entry_id: row.kb_entry_id, link_type: row.link_type })
            .first('id');
          if (clash) {
            await db('knowledge_bridge').where({ id: row.id }).del();
          } else {
            // wiki_slug is denormalized on bridge rows (createLink) and
            // surfaced by unifiedSearch — refresh it or API results keep
            // pointing at the deleted variant slug.
            await db('knowledge_bridge').where({ id: row.id }).update({
              wiki_entry_id: canonicalEntry.id,
              wiki_slug: canonicalSlug,
              updated_at: new Date(),
            });
          }
        }
      } catch { /* knowledge_bridge table may not exist */ }

      try {
        await db('knowledge_contradictions')
          .where({ wiki_entry_id: dupe.id })
          .update({ wiki_entry_id: canonicalEntry.id });
      } catch { /* knowledge_contradictions table may not exist */ }

      await db('knowledge_entries').where({ id: dupe.id }).del();
      await logUpdate('merge', canonicalSlug, `Merged duplicate product page ${dupe.slug} into ${canonicalSlug}`, {
        triggerType: 'wiki_generation',
      });
      logger.info(`[agronomic-wiki] Merged duplicate product page ${dupe.slug} into ${canonicalSlug}`);
    } catch (err) {
      logger.error(`[agronomic-wiki] Failed to merge duplicate page ${variantSlug}: ${err.message}`);
    }
  }
}

function aggregateOutcomes(outcomes) {
  if (!outcomes.length) return { count: 0 };

  const avg = (arr) => {
    const valid = arr.filter((v) => v != null);
    return valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : null;
  };

  const deltas = {
    turf_density: outcomes.map((o) => o.delta_turf_density),
    weed_suppression: outcomes.map((o) => o.delta_weed_suppression),
    color_health: outcomes.map((o) => o.delta_color_health),
    fungus_control: outcomes.map((o) => o.delta_fungus_control),
    thatch_level: outcomes.map((o) => o.delta_thatch_level),
  };

  const seasons = {};
  const grassTypes = {};
  const tracks = {};
  for (const o of outcomes) {
    if (o.season) seasons[o.season] = (seasons[o.season] || 0) + 1;
    if (o.grass_type) grassTypes[o.grass_type] = (grassTypes[o.grass_type] || 0) + 1;
    if (o.grass_track) tracks[o.grass_track] = (tracks[o.grass_track] || 0) + 1;
  }

  return {
    count: outcomes.length,
    avgDelta: {
      turf_density: avg(deltas.turf_density),
      weed_suppression: avg(deltas.weed_suppression),
      color_health: avg(deltas.color_health),
      fungus_control: avg(deltas.fungus_control),
      thatch_level: avg(deltas.thatch_level),
    },
    avgDaysBetween: avg(outcomes.map((o) => o.days_between_assessments)),
    seasonDistribution: seasons,
    grassTypeDistribution: grassTypes,
    trackDistribution: tracks,
  };
}

module.exports = AgronomicWiki;

module.exports.TRUSTED_STATUSES = TRUSTED_STATUSES;
module.exports.recomputeEntryReviewGate = recomputeEntryReviewGate;

// Exposed for unit tests only.
module.exports.__private = {
  escapeLike,
  extractSummary,
  sameSourceIds,
  resolveCanonicalProduct,
  classifyReviewTier,
  sameFlagSets,
  PRE_ASSESSMENT_MAX_AGE_DAYS,
  POST_ASSESSMENT_MAX_DAYS,
};
