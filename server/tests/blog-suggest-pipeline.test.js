/**
 * "Suggest a post" rows in the autonomous blog chain (GitHub Codex P1 on
 * ba9bed50fc). They share the operator_intercept bucket so the chain takes a
 * new topic without search-traffic history, but nobody authored their
 * brief: they are SERP-profiled, the router's terminal safety demotions
 * (public-health, navigational, the profiler's do_not_publish) stop them as
 * they stop any mined topic, and the quality gate waives only GSC evidence.
 * Operator-authored intercepts keep every exemption they had.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const router = require('../services/content/decision-router');
const queue = require('../services/content/opportunity-queue');
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');
const { checkSerpBriefAttached, checkGscSignalAttached } = require('../services/content/content-quality-gate')._internals;
const { suggestionRow } = require('../services/service-report/report-blog-suggestion');

const SUGGESTED_AT = new Date('2026-10-03T12:00:00Z');
const suggestion = () => ({ id: 'opp-s', ...suggestionRow('dengue mosquito symptoms', { actorId: 'admin-1', now: SUGGESTED_AT }) });
const intercept = (meta = { operator_pinned: true }) => ({
  id: 'opp-i', bucket: 'operator_intercept', action_type: 'new_supporting_blog', score: 90,
  query: 'orkin vs terminix', page_url: null, city: null, service: 'pest', signal_metadata: meta,
});
const SERPS = [
  ['a public-health SERP', { dominant_intent: 'public-health' }, 'SERP dominated by public-health resources; Waves cannot displace .gov'],
  ['a navigational SERP', { dominant_intent: 'navigational' }, 'navigational intent (brand match) — no content opportunity'],
  ['the profiler\'s do_not_publish', { dominant_intent: 'informational', recommended_asset_type: 'do_not_publish' }, 'SERP profiler explicit do_not_publish'],
];

describe('decision-router', () => {
  test.each(SERPS)('a suggestion with %s is stopped for review, as a mined topic is', (_label, serp_profile, reason) => {
    expect(router.route(suggestion(), { serp_profile })).toMatchObject({ action_type: 'do_not_publish', page_type: 'none', human_review_required: true, human_review_reason: reason });
    const mined = { ...suggestion(), bucket: 'no_content_yet', signal_metadata: {} };
    expect(router.route(mined, { serp_profile })).toMatchObject({ action_type: 'do_not_publish', human_review_required: true, human_review_reason: reason });
  });

  test('a clean SERP keeps a suggestion\'s action fixed; with no SERP it routes as pinned and the gate\'s SERP check holds it', () => {
    expect(router.route(suggestion(), { serp_profile: { dominant_intent: 'informational', recommended_asset_type: 'create_or_refresh_city_service_page' } }))
      .toMatchObject({ action_type: 'new_supporting_blog', human_review_required: false });
    expect(router.route(suggestion(), {})).toMatchObject({ action_type: 'new_supporting_blog', human_review_required: false });
  });

  test.each(SERPS)('an operator-authored intercept stays pinned through %s', (_label, serp_profile) => {
    expect(router.route(intercept(), { serp_profile })).toMatchObject({ action_type: 'new_supporting_blog', human_review_required: false });
  });
});

describe('brief composition', () => {
  afterEach(() => jest.restoreAllMocks());
  function stubBuilder(opp, serp_profile) {
    const builder = new ContentBriefBuilder();
    jest.spyOn(queue, 'getById').mockResolvedValue(opp);
    builder._gatherSignals = jest.fn().mockResolvedValue({ serp_profile, customer_signal: null, conversion_feedback: null });
    builder._countExistingBriefs = jest.fn().mockResolvedValue(0);
    builder._loadFactsPack = jest.fn().mockResolvedValue(null);
    builder._loadRelatedPosts = jest.fn().mockResolvedValue([]);
    builder._composeBrief = jest.fn(({ opportunity, decision }) => ({ opportunity, decision }));
    return builder;
  }

  test('a suggestion\'s signals are gathered, and a public-health SERP stops it before any draft', async () => {
    const builder = stubBuilder(suggestion(), { dominant_intent: 'public-health' });
    const out = await builder.compose('opp-s', { persist: false, skipSerp: false });
    expect(builder._gatherSignals).toHaveBeenCalledWith(expect.objectContaining({ id: 'opp-s' }), { skipSerp: false });
    expect(out.decision).toMatchObject({ action_type: 'do_not_publish', human_review_reason: 'SERP dominated by public-health resources; Waves cannot displace .gov' });
  });

  test('an operator-authored intercept still skips signal gathering and stays pinned', async () => {
    const builder = stubBuilder(intercept(), { dominant_intent: 'public-health' });
    const out = await builder.compose('opp-i', { persist: false, skipSerp: true });
    expect(builder._gatherSignals).not.toHaveBeenCalled();
    expect(out.decision.action_type).toBe('new_supporting_blog');
  });

  test('a suggestion brief carries its provenance in gsc_signal; an intercept brief does not', () => {
    const builder = new ContentBriefBuilder();
    const decision = { page_type: 'supporting-blog', action_type: 'new_supporting_blog', final_score: 79, score_breakdown: {} };
    const signals = { customer_signal: null, serp_profile: null, conversion_feedback: null };
    const compose = (opportunity) => builder._composeBrief({ opportunity, signals, decision, existingBriefVersions: 0 }).gsc_signal;
    expect(compose(suggestion())).toMatchObject({ bucket: 'operator_intercept', intercept: false, suggested: true, suggested_at: SUGGESTED_AT.toISOString() });
    expect(compose(intercept())).not.toHaveProperty('suggested');
  });
});

describe('quality gate evidence checks', () => {
  const brief = (gsc_signal, serp_signal = null) => ({ target_keyword: 'dengue mosquito symptoms', target_url: null, gsc_signal, serp_signal });
  const SUGGESTED = { bucket: 'operator_intercept', intercept: false, suggested: true, suggested_at: SUGGESTED_AT.toISOString() };

  test('a suggestion brief keeps the SERP check; only GSC evidence is waived', () => {
    expect(checkSerpBriefAttached({}, brief(SUGGESTED))).toEqual({ ok: false, reason: 'no_serp_signal' });
    expect(checkSerpBriefAttached({}, brief(SUGGESTED, { dominant_intent: 'informational' }))).toEqual({ ok: true });
    expect(checkGscSignalAttached({}, brief(SUGGESTED))).toEqual({ ok: true, reason: 'office_suggestion' });
  });

  test('a suggestion brief that lost its provenance gets no waiver at all', () => {
    const lost = { bucket: 'operator_intercept', suggested: true };
    expect(checkSerpBriefAttached({}, brief(lost)).ok).toBe(false);
    expect(checkGscSignalAttached({}, brief(lost)).ok).toBe(false);
  });

  test('an operator-authored brief keeps both waivers', () => {
    const authored = { bucket: 'operator_intercept', intercept: true };
    expect(checkSerpBriefAttached({}, brief(authored))).toEqual({ ok: true, reason: 'operator_authored_brief' });
    expect(checkGscSignalAttached({}, brief(authored))).toEqual({ ok: true, reason: 'operator_authored_brief' });
  });
});
