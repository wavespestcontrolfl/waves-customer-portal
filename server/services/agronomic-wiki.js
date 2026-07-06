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

const MODEL = require('../config/models').FLAGSHIP;

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
  /re-entry interval/i,
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
    return {
      tier: existing.review_tier,
      flags: existingFlags,
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
  } catch { /* knowledge_base may not exist */ }
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
async function recomputeEntryReviewGate(entryId) {
  if (!entryId) return;
  try {
    const existing = await db('knowledge_entries').where({ id: entryId }).first();
    if (!existing) return;
    const review = resolveReviewFields(existing, {
      confidence: existing.confidence,
      content: existing.content,
      openContradictionIds: await getOpenContradictionIdsFor(entryId, existing),
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
    logger.error(`[agronomic-wiki] recomputeEntryReviewGate failed for entry ${entryId}: ${err.message}`);
  }
}

async function callClaude(systemPrompt, userPrompt) {
  if (!Anthropic) {
    logger.warn('[agronomic-wiki] Anthropic SDK not available — skipping AI generation');
    return null;
  }
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
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

      // 8. Queue wiki page updates (fire-and-forget so we don't block the confirm)
      setImmediate(async () => {
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
  // updateProductPage — aggregate outcomes for a product, generate wiki page
  // ────────────────────────────────────────────────────────────
  async updateProductPage(productName) {
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
        return null;
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

      return entry;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateProductPage failed for ${productName}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateConditionPage — aggregate outcomes for a pest/disease/weed condition
  // ────────────────────────────────────────────────────────────
  async updateConditionPage(conditionName) {
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
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateConditionPage failed for ${conditionName}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateTrackPage — aggregate performance across all customers on a track
  // ────────────────────────────────────────────────────────────
  async updateTrackPage(trackId) {
    try {
      const slug = `track/${slugify(trackId)}`;

      const outcomes = await db('treatment_outcomes')
        .where({ grass_track: trackId })
        .orderBy('visit_number', 'asc')
        .orderBy('treatment_date', 'desc');

      if (!outcomes.length) {
        logger.info(`[agronomic-wiki] No outcomes found for track ${trackId}`);
        return null;
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
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateTrackPage failed for ${trackId}: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // updateSeasonalPage — aggregate what happened this month
  // ────────────────────────────────────────────────────────────
  async updateSeasonalPage(month) {
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
        try {
          const pruned = await db('knowledge_entries')
            .where({ slug, category: 'seasonal' })
            .del();
          if (pruned) {
            await logUpdate('prune', slug, `Pruned zero-outcome seasonal page for ${monthName}`, {
              triggerType: 'wiki_generation',
            });
          }
        } catch (err) {
          logger.error(`[agronomic-wiki] Failed to prune empty seasonal page ${slug}: ${err.message}`);
        }
        logger.info(`[agronomic-wiki] No outcomes found for month ${month} — skipping seasonal page`);
        return null;
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
      return result?.entry || null;
    } catch (err) {
      logger.error(`[agronomic-wiki] updateSeasonalPage failed for month ${month}: ${err.message}`);
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

      let refreshed = 0;
      for (const page of stalePages) {
        try {
          if (page.category === 'product') {
            const productName = page.title.replace(/^Product:\s*/i, '');
            await AgronomicWiki.updateProductPage(productName);
            refreshed++;
          } else if (page.category === 'track') {
            const trackId = page.slug.replace('track/', '');
            await AgronomicWiki.updateTrackPage(trackId);
            refreshed++;
          } else if (page.category === 'seasonal') {
            const monthSlug = page.slug.replace('seasonal/', '');
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const monthIdx = monthNames.indexOf(monthSlug);
            if (monthIdx >= 0) {
              await AgronomicWiki.updateSeasonalPage(monthIdx + 1);
              refreshed++;
            }
          } else if (page.category === 'condition') {
            const conditionName = page.title.replace(/^Condition:\s*/i, '');
            await AgronomicWiki.updateConditionPage(conditionName);
            refreshed++;
          }
        } catch (err) {
          logger.error(`[agronomic-wiki] Failed to refresh page ${page.slug}: ${err.message}`);
        }
      }

      // 3. Generate seasonal page for current month
      const currentMonth = new Date().getMonth() + 1;
      await AgronomicWiki.updateSeasonalPage(currentMonth);

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
