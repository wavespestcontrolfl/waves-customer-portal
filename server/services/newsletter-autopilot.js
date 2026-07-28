/**
 * Newsletter Autopilot — guarded auto-draft for the weekly digest.
 *
 * Called by the Monday 7 AM ET cron in scheduler.js. Never auto-sends;
 * creates a draft in newsletter_sends for admin review + manual send.
 *
 * Flow:
 *   1. Compute the upcoming issue Tuesday
 *   2. Check newsletter_calendar for a pre-planned entry
 *   3. Skip if calendar row already has a send_id or terminal status
 *   4. Generate a digest plan from approved events (same query pattern
 *      as POST /events/digest-plan in admin-newsletter.js)
 *   5. Preflight gate — skip with an actionable notification if the week
 *      fails the flagship quality contract (min events / source diversity)
 *   6. Build a prompt incorporating calendar topic / homeowner minute
 *   7. Delegate AI drafting to shared createNewsletterDraft() service
 *   8. Link the resulting send to the calendar entry (or create one)
 *   9. Notify admin that a draft is ready
 */

const db = require('../models/db');
const logger = require('./logger');
const {
  isEligibleForFreshDigest,
  scoreFreshEvent,
  excludeRepeatedDateIdentities,
  dedupeDigestEvents,
  excludeRoutineRecurringFromQuery,
  getActiveNewsletterTuesday,
  defaultTargetSendAt,
  getNewsletterDraftWindowStart,
  weekLockKey,
} = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');
const { createNewsletterDraft, persistNewsletterDraft } = require('./newsletter-draft');
const {
  filterPreviouslyFeaturedIdentities,
  filterRepeatedDateIdentities,
} = require('./newsletter-event-selection');
const {
  selectPortfolio, rankAlternates, effectiveScore, unmetConstraints,
  MAX_COUNT: MAX_PORTFOLIO,
} = require('./newsletter-portfolio');
const { featureScoreFloor } = require('./event-scoring');
const { getFlagshipType } = require('../config/newsletter-types');

const NEWSLETTER_TYPE = 'local-weekly-fresh-events';

// Lineup cap — diversity/coverage stats are measured over the events that
// would actually appear (top-N by score), matching the draft selection.
const LINEUP_CAP = 12;

/**
 * Build the digest plan — same query as POST /events/digest-plan
 * in admin-newsletter.js, but without the HTTP layer.
 */
async function buildDigestPlan({ reference = new Date() } = {}) {
  const weekOf = getActiveNewsletterTuesday(reference);
  const startDate = parseETDateTime(`${weekOf}T00:00:00`);
  const endDate = parseETDateTime(`${etDateString(addETDays(startDate, 6))}T23:59:59`);

  const query = db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(
      'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
      'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url', 'e.image_url',
      'e.event_type', 'e.recurrence_type', 'e.freshness_status', 'e.freshness_score',
      'e.admin_status', 'e.times_featured', 'e.last_featured_at', 'e.pulled_at', 'e.source_id',
      'e.region_zone', 'e.family_friendly', 'e.is_free', 'e.price_text',
      'e.editorial_score', 'e.score_breakdown', 'e.novelty_type', 'e.audience_tags',
      's.name as source_name', 's.priority_tier as source_priority_tier',
    )
    .whereIn('e.admin_status', ['approved', 'featured'])
    .whereNull('e.merged_into')
    .where('e.start_at', '>=', startDate)
    .where('e.start_at', '<=', endDate)
    .whereNotNull('e.event_url')
    .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
    .orderByRaw('e.freshness_score DESC NULLS LAST');

  const rows = await excludeRoutineRecurringFromQuery(query);

  const nonRepeatedRows = await filterRepeatedDateIdentities(rows, { reference: startDate });
  const historicallyNewRows = await filterPreviouslyFeaturedIdentities(nonRepeatedRows, { reference: startDate });
  const eligible = historicallyNewRows.filter((r) => isEligibleForFreshDigest(r, startDate));
  const scored = dedupeDigestEvents(eligible
    .map((r) => ({ ...r, compositeScore: scoreFreshEvent(r) }))
    .sort((a, b) => b.compositeScore - a.compositeScore));

  return { rows, eligible, scored, startDate, endDate, weekOf };
}

/**
 * Preflight the weekly digest against the flagship type's declared quality
 * contract. Pure function over a built plan — no DB calls.
 *
 * Hard failures (caller should SKIP the auto-draft):
 *   - fewer than `minVerifiedFreshEvents` eligible events
 *   - fewer than `minSourceDiversity` distinct sources in the lineup
 *
 * Soft warnings (draft proceeds, surfaced on the notification):
 *   - fewer than `minCityDiversity` distinct cities/zones
 *   - image coverage below `minImageCoverage`
 *
 * @param {Array|{ scored: Array }} lineup - the resolved draft lineup (event
 *   objects), or a plan `{ scored }` for convenience. Preflight runs on the
 *   events that will actually be drafted, not the raw score order.
 * @param {Object} reqs - sourceRequirements from the flagship type config
 * @returns {{ pass: boolean, hardFailures: string[], warnings: string[], stats: Object, thresholds: Object }}
 */
function preflightDigest(lineupOrPlan, reqs = {}) {
  const {
    minVerifiedFreshEvents = 5,
    minSourceDiversity = 2,
    minCityDiversity = 2,
    minImageCoverage = 0.5,
  } = reqs;

  const rawEvents = Array.isArray(lineupOrPlan)
    ? lineupOrPlan
    : (Array.isArray(lineupOrPlan?.scored) ? lineupOrPlan.scored : []);

  // Dedupe by event id — a planned calendar row can carry duplicate
  // event_ids (admin save validates UUID/length, not uniqueness). Counting
  // duplicates would let a thin lineup like [A,B,A,B,A] pass the 5-event /
  // 2-source gate even though createNewsletterDraft() fetches only the
  // distinct rows. Events without an id can't be deduped, so keep them.
  const seenIds = new Set();
  const events = dedupeDigestEvents(excludeRepeatedDateIdentities(rawEvents.filter((e) => {
    const id = e && e.id != null ? String(e.id) : null;
    if (id === null) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  })));

  const eligibleCount = events.length;
  const lineup = events.slice(0, LINEUP_CAP);

  const sources = new Set(lineup.map((e) => e.source_id || e.source_name).filter(Boolean));
  const cities = new Set(
    lineup.map((e) => (e.city || e.region_zone || '').trim().toLowerCase()).filter(Boolean),
  );
  const withImage = lineup.filter((e) => e.image_url).length;
  const imageCoverage = lineup.length ? withImage / lineup.length : 0;

  const stats = {
    eligibleCount,
    lineupSize: lineup.length,
    sourceCount: sources.size,
    cityCount: cities.size,
    imageCoverage: Math.round(imageCoverage * 100) / 100,
  };

  const hardFailures = [];
  if (eligibleCount < minVerifiedFreshEvents) {
    hardFailures.push(`Eligible fresh approved events: ${eligibleCount} / required ${minVerifiedFreshEvents}`);
  }
  if (stats.sourceCount < minSourceDiversity) {
    hardFailures.push(`Source diversity: ${stats.sourceCount} / required ${minSourceDiversity}`);
  }

  const warnings = [];
  if (stats.cityCount < minCityDiversity) {
    warnings.push(`City diversity: ${stats.cityCount} / recommended ${minCityDiversity}`);
  }
  if (imageCoverage < minImageCoverage) {
    warnings.push(`Image coverage: ${Math.round(imageCoverage * 100)}% / recommended ${Math.round(minImageCoverage * 100)}%`);
  }

  return {
    pass: hardFailures.length === 0,
    hardFailures,
    warnings,
    stats,
    thresholds: { minVerifiedFreshEvents, minSourceDiversity, minCityDiversity, minImageCoverage },
  };
}

/**
 * Render an actionable skip notification body from a preflight report.
 * sourceHealthLines (optional) names the failing / zero-yield sources so
 * the operator sees WHY the eligible pool is thin, not just that it is.
 */
function formatPreflightReport(report, weekOf, sourceHealthLines = []) {
  const lines = [`Waves Newsletter autopilot skipped (week of ${weekOf}).`, '', 'Reason:'];
  for (const f of report.hardFailures) lines.push(`- ${f}`);
  for (const w of report.warnings) lines.push(`- ${w} (warning)`);
  if (sourceHealthLines.length) {
    lines.push('', 'Source health:');
    for (const l of sourceHealthLines) lines.push(l);
  }
  lines.push('', 'Next actions:');
  lines.push('- Approve more pending events for this Tue–Mon window');
  lines.push('- Check failing ingestion sources (Events → Sources health)');
  lines.push('- Add/repair event URLs where missing');
  return lines.join('\n');
}

/**
 * Auto-draft the weekly flagship newsletter.
 *
 * @returns {{ skipped: boolean, reason?: string, sendId?: number, eventCount?: number }}
 */
async function autoDraftFlagship() {
  logger.info('[newsletter-autopilot] Starting weekly auto-draft');

  // 1. Compute the active issue Tuesday (Monday drafts target tomorrow)
  const weekOf = getActiveNewsletterTuesday();
  logger.info(`[newsletter-autopilot] Week of: ${weekOf}`);

  // 2. Check the calendar for existing entry — skip if already handled
  const existingCalendar = await db('newsletter_calendar')
    .where('week_of', weekOf)
    .first();

  if (existingCalendar && existingCalendar.send_id) {
    const reason = `Calendar already has send_id: ${existingCalendar.send_id}`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    // Retry lane for a proof whose SendGrid call failed transiently.
    // ONLY for 'drafted' weeks — a linked row whose status is 'skipped'
    // (or scheduled/sent) was deliberately retired by the operator, and
    // proofing it would let an approval reply send a retired campaign.
    // sendNewsletterProof is idempotent (proof_sent_at claim) and skips
    // non-draft sends, so calling it here is safe every tick.
    if (existingCalendar.status === 'drafted') {
      try {
        const { sendNewsletterProof } = require('./newsletter-proof');
        await sendNewsletterProof(existingCalendar.send_id);
      } catch (e) {
        logger.warn(`[newsletter-autopilot] proof retry failed: ${e.message}`);
      }
    }
    return { skipped: true, reason };
  }

  if (existingCalendar && existingCalendar.status === 'skipped') {
    const reason = 'Calendar status is skipped';
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  if (existingCalendar && ['scheduled', 'sent'].includes(existingCalendar.status)) {
    const reason = `Calendar status is ${existingCalendar.status}`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  if (existingCalendar && existingCalendar.status === 'drafted' && existingCalendar.send_id) {
    const reason = `Calendar already drafted (send_id: ${existingCalendar.send_id})`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  // drafted without send_id falls through — autopilot will re-draft

  // 3. Look for a planned calendar entry with editorial guidance
  const calendarEntry = (existingCalendar && existingCalendar.status === 'planned')
    ? existingCalendar
    : null;

  // 4. Build digest plan
  const plan = await buildDigestPlan();
  const { scored } = plan;

  // 5. Resolve the lineup the draft will actually use — calendar-curated
  //    event_ids (intersected with the eligible pool) take precedence over
  //    raw score order, padded with top-scored events to fill the slate.
  //    The preflight MUST run on this lineup, not the raw score order, or an
  //    operator-planned diverse week could be wrongly skipped because the
  //    automatic top-12 happened to be single-source.
  const topic = calendarEntry?.topic;
  const homeownerMinuteTopic = calendarEntry?.homeowner_minute_topic;
  const preferredEventIds = Array.isArray(calendarEntry?.event_ids) ? calendarEntry.event_ids : [];

  // Portfolio selection (owner spec 2026-07-28): the lineup is the
  // strongest COMBINATION — floor-enforced, weekend/zone/audience
  // balanced, capped per venue/source — not the raw top-N. Calendar-
  // curated picks still take precedence: a full operator slate is used
  // verbatim; a partial one SEEDS the selector, so caps and coverage are
  // enforced against the combined lineup, not just the supplement.
  const byId = new Map(scored.map((ev) => [ev.id, ev]));
  // Dedupe preferred ids — a calendar row may carry duplicates (admin save
  // validates UUID/length, not uniqueness); dupes would inflate the lineup.
  // The ABSOLUTE editorial floor applies to calendar picks too: `scored`
  // still contains approved-but-sub-floor events, and both the full-slate
  // and seeded paths would otherwise publish them. Only the explicit
  // operator star overrides the floor (effectiveScore already grants
  // featured rows hero grade).
  const floorPassed = (ev) => ev.admin_status === 'featured'
    || effectiveScore(ev) >= featureScoreFloor();
  const rawPreferred = [...new Set(preferredEventIds.filter((id) => byId.has(id)))];
  const eligiblePreferred = rawPreferred.filter((id) => floorPassed(byId.get(id)));
  if (eligiblePreferred.length !== rawPreferred.length) {
    logger.info(`[newsletter-autopilot] ${rawPreferred.length - eligiblePreferred.length} calendar pick(s) below the editorial floor excluded (star an event to override)`);
  }
  const preferredEvents = eligiblePreferred.map((id) => byId.get(id));

  let lineupEvents;
  let portfolio;
  if (eligiblePreferred.length >= 5) {
    // Calendar picks are all eligible — use them, in the operator's order
    lineupEvents = preferredEvents;
    portfolio = { selected: preferredEvents, unmet: [], stats: null };
  } else {
    portfolio = selectPortfolio(scored, { seeded: preferredEvents });
    lineupEvents = portfolio.selected.slice(0, MAX_PORTFOLIO);
  }
  // Alternates rank against the FINAL lineup — an operator-preferred
  // event capped out of the selection must never be stored as both a
  // locked event and its own replacement. Operator-full slates skip
  // alternates entirely (the slate is the operator's intent).
  const lineupAlternates = eligiblePreferred.length >= 5
    ? []
    : rankAlternates(scored, lineupEvents);
  if (portfolio.unmet.length) {
    logger.info(`[newsletter-autopilot] portfolio shortfalls (publishing anyway, never padding): ${portfolio.unmet.join('; ')}`);
  }

  // 6. Preflight gate — enforce the flagship type's declared quality
  //    contract against the RESOLVED lineup. Hard-fail (skip) on too few
  //    events or too few sources; city diversity + image coverage are soft
  //    warnings carried onto the draft for now. Thresholds come from the
  //    type config so they tune in one place.
  const reqs = getFlagshipType()?.sourceRequirements || {};
  const preflight = preflightDigest(lineupEvents, reqs);
  // Skip-week routine, shared by the pre-generation preflight and the
  // post-generation lineup-coverage recheck. Persists a durable 'skipped'
  // marker (the catch-up gate only re-runs missing/'planned' weeks) and
  // notifies the admin with an actionable report.
  const skipWeek = async (preflightReport) => {
    const reason = preflightReport.hardFailures.join('; ');
    logger.info(`[newsletter-autopilot] Preflight skip: ${reason}`);
    try {
      await db('newsletter_calendar')
        .insert({
          week_of: weekOf,
          status: 'skipped',
          target_send_at: defaultTargetSendAt(weekOf),
          event_ids: JSON.stringify([]),
        })
        .onConflict('week_of')
        .merge({ status: 'skipped', updated_at: db.fn.now() });
    } catch (e) {
      logger.warn(`[newsletter-autopilot] failed to mark week skipped: ${e.message}`);
    }
    try {
      // Name the broken sources in the report — a thin eligible pool is
      // almost always upstream source rot, not an approval backlog.
      let sourceHealthLines = [];
      try {
        const { classifyUnhealthySources, formatSourceHealthLines } = require('./event-source-health');
        const sourceRows = await db('event_sources').where({ enabled: true });
        sourceHealthLines = formatSourceHealthLines(classifyUnhealthySources(sourceRows));
      } catch (e) {
        logger.warn(`[newsletter-autopilot] source health fetch failed: ${e.message}`);
      }
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('newsletter_autopilot_skipped', {
        eligible: preflightReport.stats.eligibleCount,
        reason,
        preflight: preflightReport.stats,
        report: formatPreflightReport(preflightReport, weekOf, sourceHealthLines),
      });
    } catch (e) {
      logger.warn(`[newsletter-autopilot] skip notification failed: ${e.message}`);
    }
    return { skipped: true, reason, preflight: preflightReport.stats };
  };

  if (!preflight.pass) {
    return skipWeek(preflight);
  }
  if (preflight.warnings.length) {
    logger.info(`[newsletter-autopilot] Preflight warnings: ${preflight.warnings.join('; ')}`);
  }

  // 7. Build prompt incorporating calendar data + derive event IDs from the
  //    resolved lineup (same set the preflight just validated).
  const prompt = topic
    ? `This weekend's theme: ${topic}. New events from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`
    : `New events for the weekend ahead from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`;

  const eventIds = lineupEvents.map((ev) => ev.id);

  // Sanitize event IDs — calendar event_ids come from JSONB and may contain
  // malformed values that would cause Postgres uuid type errors in whereIn.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let safeEventIds = eventIds.filter(id => typeof id === 'string' && uuidRe.test(id));

  // Verify selected events still exist — supplement if stale IDs reduced the count
  // Drop locked ids whose rows disappeared between planning and now —
  // a stale UUID left in place would pass here and then fail the final
  // proof/delivery validation. Refill (only when thin) from the ranked
  // alternates, the floor-passing pool built for exactly this. Operator
  // slates larger than the portfolio cap are kept intact — only refill
  // additions respect the cap.
  const existingIds = new Set(
    (await db('events_raw').whereIn('id', safeEventIds).pluck('id')).map(String),
  );
  const staleCount = safeEventIds.length - existingIds.size;
  safeEventIds = safeEventIds.filter((id) => existingIds.has(String(id)));
  if (staleCount > 0) {
    logger.info(`[newsletter-autopilot] Dropped ${staleCount} stale locked event id(s)`);
  }
  if (safeEventIds.length < 5 && lineupAlternates.length > 0) {
    const refillCandidates = lineupAlternates
      .map((ev) => String(ev.id))
      .filter((id) => uuidRe.test(id) && !safeEventIds.includes(id));
    if (refillCandidates.length) {
      const refillExisting = new Set(
        (await db('events_raw').whereIn('id', refillCandidates).pluck('id')).map(String),
      );
      for (const id of refillCandidates) {
        if (safeEventIds.length >= MAX_PORTFOLIO) break;
        if (refillExisting.has(id)) safeEventIds.push(id);
      }
      logger.info(`[newsletter-autopilot] Refilled lineup to ${safeEventIds.length} from ranked alternates`);
    }
  }

  // 7. Idempotency: transaction-scoped advisory lock so the dedupe check +
  //    insert are atomic. pg_advisory_xact_lock auto-releases when the
  //    transaction ends — no leak if the process crashes mid-flight. The key is
  //    per-WEEK (weekLockKey) and shared with the draft-from-plan route so the
  //    two paths can't both create a draft for the same week.
  const lockKey = weekLockKey(weekOf);

  // Paid/network work stays outside the DB transaction and advisory lock.
  // The short locked section below only dedupes + persists. Two truly
  // concurrent runners may both generate, but only one can create a row.
  let generated = await createNewsletterDraft({
    prompt,
    eventIds: safeEventIds,
    homeownerMinuteTopic,
    topic,
    newsletterType: NEWSLETTER_TYPE,
    issueReference: defaultTargetSendAt(weekOf),
    persist: false,
  });

  // The model may return only a SUBSET of the locked ids, and
  // persistNewsletterDraft records exactly what it returned — a
  // preflight-passing eight-event portfolio could otherwise persist and
  // ship as a thin, unbalanced lineup nobody re-validated. Retry the
  // generation once on incomplete coverage; then re-run the preflight on
  // the ACTUAL lineup and skip the week (fail closed) if it no longer
  // holds. Alternates are recomputed against the actual lineup below.
  // Build the actual lineup from ALL scored events keyed by the drafted
  // ids — safeEventIds may include refilled alternates that are not in
  // lineupEvents, and deriving from lineupEvents alone would treat every
  // successfully-generated replacement as missing.
  const lineupFromDraft = (g) => {
    const drafted = new Set((g?.draft?.events || []).map((e) => String(e.eventId)));
    return safeEventIds.filter((id) => drafted.has(String(id)))
      .map((id) => byId.get(id))
      .filter(Boolean);
  };
  let actualLineup = lineupFromDraft(generated);
  if (actualLineup.length !== safeEventIds.length) {
    logger.warn(`[newsletter-autopilot] draft covered ${actualLineup.length}/${safeEventIds.length} locked events — regenerating once`);
    const retry = await createNewsletterDraft({
      prompt,
      eventIds: safeEventIds,
      homeownerMinuteTopic,
      topic,
      newsletterType: NEWSLETTER_TYPE,
      issueReference: defaultTargetSendAt(weekOf),
      persist: false,
    });
    const retryLineup = lineupFromDraft(retry);
    // Prefer the retry on strictly better coverage — or on EQUAL coverage
    // when the retry's lineup passes the quality contract and the first
    // draft's does not (cardinality alone would discard a passing retry
    // and durably skip the week).
    const preferRetry = retryLineup.length > actualLineup.length
      || (retryLineup.length === actualLineup.length
        && !preflightDigest(actualLineup, reqs).pass
        && preflightDigest(retryLineup, reqs).pass);
    if (preferRetry) {
      generated = retry;
      actualLineup = retryLineup;
    }
  }
  if (actualLineup.length !== safeEventIds.length) {
    const actualPreflight = preflightDigest(actualLineup, reqs);
    if (!actualPreflight.pass) {
      actualPreflight.hardFailures.unshift(
        `Draft generation dropped ${safeEventIds.length - actualLineup.length} locked event(s) and the remaining lineup fails the quality contract`,
      );
      return skipWeek(actualPreflight);
    }
    // The count/source contract held — also re-check the PORTFOLIO
    // minimums (weekend/zone/audience/free/hero/novelty). Per the
    // selector's own publish-fewer rule these are shortfalls to SURFACE,
    // not grounds to retire the week: they ride the preflight warnings
    // onto the draft notification and the proof.
    const degradedUnmet = unmetConstraints(actualLineup).map((c) => c.label);
    if (degradedUnmet.length) {
      preflight.warnings.push(...degradedUnmet.map((l) => `Degraded lineup shortfall: ${l}`));
    }
    logger.warn(`[newsletter-autopilot] proceeding with degraded ${actualLineup.length}-event lineup (passes preflight${degradedUnmet.length ? `; unmet: ${degradedUnmet.join('; ')}` : ''})`);
  }
  // Alternates must rank against what will actually persist.
  const persistedAlternates = eligiblePreferred.length >= 5
    ? []
    : rankAlternates(scored, actualLineup);

  let send;
  let earlyReturn = null;

  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [lockKey]);

    const existing = await trx('newsletter_sends')
      .where({ newsletter_type: NEWSLETTER_TYPE, status: 'draft' })
      .whereNull('created_by')
      // Drafting moved to Monday while the issue/event window starts Tuesday.
      // Include that Monday or the serialized runner cannot see its own first
      // draft and a catch-up/concurrent run creates a second campaign + proof.
      .where('created_at', '>=', getNewsletterDraftWindowStart(weekOf))
      // Bound the window to THIS issue and exclude drafts already claimed by
      // another calendar week: an operator-generated FUTURE issue draft
      // shares type/status/null-created_by and a recent created_at, and
      // without these guards this week's autopilot would adopt it, proof it
      // as the current issue, and never create the real one.
      .where('created_at', '<', defaultTargetSendAt(weekOf))
      .whereNotExists(function otherWeekCalendarLink() {
        this.select(trx.raw('1'))
          .from('newsletter_calendar as c')
          .whereRaw('c.send_id = newsletter_sends.id')
          .whereNot('c.week_of', weekOf);
      })
      .first();

    if (existing) {
      logger.info(`[newsletter-autopilot] draft already exists for this week: ${existing.id}`);
      earlyReturn = { skipped: true, reason: `Draft already exists: ${existing.id}`, sendId: existing.id };
      return; // transaction commits → lock auto-releases
    }

    // 8. Persist the already-generated draft while the dedupe lock is held.
    send = await persistNewsletterDraft({
      draft: generated.draft,
      prompt,
      newsletterType: NEWSLETTER_TYPE,
      knex: trx,
    });

    // Ranked alternates ride the send row for the proof diagnostics and
    // as named replacements if a locked event dies before dispatch.
    const alternateIds = persistedAlternates
      .map((ev) => ev.id)
      .filter((id) => typeof id === 'string' && uuidRe.test(id));
    if (alternateIds.length) {
      await trx('newsletter_sends')
        .where({ id: send.id })
        .update({ alternate_event_ids: JSON.stringify(alternateIds), updated_at: trx.fn.now() });
    }
    // transaction commits → lock auto-releases
  });

  if (earlyReturn) {
    // Calendar may still be unlinked after a partial failure (draft created
    // but calendar update didn't complete). Fix the linkage before returning.
    if (existingCalendar && !existingCalendar.send_id) {
      // Verify the deduped send is actually a flagship newsletter for this week
      const dedupedSend = await db('newsletter_sends')
        .where({ id: earlyReturn.sendId, newsletter_type: NEWSLETTER_TYPE })
        .first();
      if (dedupedSend) {
        await db('newsletter_calendar')
          .where({ id: existingCalendar.id })
          .update({
            send_id: earlyReturn.sendId,
            status: 'drafted',
            updated_at: db.fn.now(),
          });
        logger.info(`[newsletter-autopilot] Linked existing draft ${earlyReturn.sendId} to calendar ${existingCalendar.id}`);
      } else {
        logger.warn(`[newsletter-autopilot] Deduped send ${earlyReturn.sendId} is not a ${NEWSLETTER_TYPE} — skipping calendar linkage`);
      }
    } else if (!existingCalendar) {
      await db('newsletter_calendar').insert({
        week_of: weekOf,
        topic: null,
        status: 'drafted',
        send_id: earlyReturn.sendId,
        target_send_at: defaultTargetSendAt(weekOf),
        event_ids: JSON.stringify([]),
      }).onConflict('week_of').merge({
        send_id: earlyReturn.sendId,
        status: 'drafted',
        updated_at: db.fn.now(),
      });
      logger.info(`[newsletter-autopilot] Created calendar entry for existing draft ${earlyReturn.sendId}`);
    }
    // The draft exists but its proof may not have gone out (e.g. the 7 AM
    // proof failed and this is the 2 PM catch-up tick). sendNewsletterProof
    // is idempotent via proof_sent_at, so retrying here is safe.
    try {
      const { sendNewsletterProof } = require('./newsletter-proof');
      await sendNewsletterProof(earlyReturn.sendId);
    } catch (e) {
      logger.warn(`[newsletter-autopilot] proof retry failed: ${e.message}`);
    }
    return earlyReturn;
  }

  // 9. Link send to calendar entry (or create one)
  if (calendarEntry) {
    await db('newsletter_calendar')
      .where({ id: calendarEntry.id })
      .update({
        send_id: send.id,
        status: 'drafted',
        updated_at: db.fn.now(),
      });
  } else {
    await db('newsletter_calendar').insert({
      week_of: weekOf,
      topic: null,
      status: 'drafted',
      send_id: send.id,
      target_send_at: defaultTargetSendAt(weekOf),
      event_ids: JSON.stringify([]),
    }).onConflict('week_of').merge({
      send_id: send.id,
      status: 'drafted',
      updated_at: db.fn.now(),
    });
  }

  logger.info(`[newsletter-autopilot] Draft created: sendId=${send.id}, events=${safeEventIds.length}`);

  // 10. Notify admin that a draft is ready
  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('newsletter_autopilot_draft', {
      sendId: send.id,
      subject: send.subject,
      eventCount: safeEventIds.length,
      calendarWeek: weekOf,
      hadCalendarEntry: !!calendarEntry,
      preflightWarnings: preflight.warnings,
    });
  } catch (e) {
    logger.warn(`[newsletter-autopilot] draft notification failed: ${e.message}`);
  }

  // 11. Proof-approval flow (gated OFF by default): email the owner a proof
  //     copy; replying "approved" queues Tuesday's 6 AM send. A proof failure
  //     never kills the draft — the admin notification above still fired.
  try {
    const { sendNewsletterProof } = require('./newsletter-proof');
    await sendNewsletterProof(send.id);
  } catch (e) {
    logger.warn(`[newsletter-autopilot] proof send failed: ${e.message}`);
  }

  return { skipped: false, sendId: send.id, eventCount: safeEventIds.length };
}

module.exports = { autoDraftFlagship, buildDigestPlan, preflightDigest, formatPreflightReport };
