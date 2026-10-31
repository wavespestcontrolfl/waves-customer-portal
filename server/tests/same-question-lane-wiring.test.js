/**
 * The pieces a same_question_refresh row passes through after it is queued:
 * router (page-anchored), brief builder (provenance on gsc_signal) and the
 * quality gate's GSC-evidence check. The row is page-only (query NULL) and
 * carries no GSC numbers, so the match itself is the provenance.
 */

const { route } = require('../services/content/decision-router');
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { checkGscSignalAttached, checkSerpBriefAttached } = require('../services/content/content-quality-gate')._internals;

const OWNER_URL = 'https://www.wavespestcontrol.com/pest-control/millipede-vs-centipede-southwest-florida/';
const SAME_QUESTION = { owner_url: OWNER_URL, owner_title: 'Millipede vs Centipede', question: 'florida millipede', tokens: ['millipede'] };
const UNANSWERED = [{ query: 'florida millipede', impressions: 0, source: 'same_question_refresh', owner_url: OWNER_URL }];

describe('decision-router', () => {
  test('stays a refresh of the owner page when the profiler recommends a blog (a reroute would recreate the duplicate)', () => {
    const r = route(
      { bucket: 'same_question_refresh', action_type: 'refresh_existing_page', page_url: OWNER_URL, score: 78 },
      { serp_profile: { dominant_intent: 'informational', dominant_page_type: 'blog', recommended_asset_type: 'new_supporting_blog', directory_saturation: 0 } },
    );
    expect(r.action_type).toBe('refresh_existing_page');
    expect(r.page_type).toBe('refresh');
    expect(r.router_notes).toMatch(/page-anchored bucket same_question_refresh/);
  });
});

describe('brief builder', () => {
  const builder = new ContentBriefBuilder();
  const decision = { action_type: 'refresh_existing_page', page_type: 'refresh', human_review_required: false, human_review_reason: null };
  const signals = { serp_profile: null, customer_signal: null, conversion_feedback: null };
  const compose = (bucket) => builder._composeBrief({
    opportunity: { id: 3, bucket, page_url: OWNER_URL, service: 'pest', city: null, query: null, signal_metadata: { same_question: SAME_QUESTION, unanswered_queries: UNANSWERED } },
    signals, decision, existingBriefVersions: 0,
  });

  test('the match and the question ride gsc_signal for the refresh agent and the quality gate', () => {
    const brief = compose('same_question_refresh');
    expect(brief.gsc_signal).toMatchObject({ bucket: 'same_question_refresh', same_question: SAME_QUESTION, unanswered_queries: UNANSWERED });
  });

  test('_gatherSignals skips the customer cluster for the null-query rewrite (it would hand an unrelated customer question to a targeted edit)', async () => {
    const b = new ContentBriefBuilder();
    b._matchCustomerCluster = jest.fn().mockResolvedValue({ topic: 'unrelated', service: 'pest' });
    const out = await b._gatherSignals({ bucket: 'same_question_refresh', query: null, service: null, city: null }, { skipSerp: true });
    expect(b._matchCustomerCluster).not.toHaveBeenCalled();
    expect(out.customer_signal).toBeNull();
  });

  test('another bucket never carries a same_question marker', () => {
    expect(compose('answer_gap').gsc_signal.same_question).toBeNull();
  });
});

describe('quality gate evidence', () => {
  const gsc = (over = {}) => ({ bucket: 'same_question_refresh', impressions: null, same_question: SAME_QUESTION, unanswered_queries: UNANSWERED, ...over });

  test('gsc_signal_attached accepts the match as evidence for a same_question_refresh brief', () => {
    const r = checkGscSignalAttached({}, { gsc_signal: gsc() });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('same_question_refresh_evidence');
  });

  test('a brief that lost its provenance still hard-fails (no owner, no question, or another bucket)', () => {
    expect(checkGscSignalAttached({}, { gsc_signal: gsc({ same_question: null }) }).ok).toBe(false);
    expect(checkGscSignalAttached({}, { gsc_signal: gsc({ same_question: { question: 'x' } }) }).ok).toBe(false);
    expect(checkGscSignalAttached({}, { gsc_signal: gsc({ unanswered_queries: [] }) }).ok).toBe(false);
    expect(checkGscSignalAttached({}, { gsc_signal: gsc({ bucket: 'decay_refresh' }) }).ok).toBe(false);
  });

  test('the page-only brief (no target keyword, a target page) skips the SERP evidence check like other page-anchored refreshes', () => {
    expect(checkSerpBriefAttached({}, { target_keyword: null, target_url: OWNER_URL, gsc_signal: gsc() }).ok).toBe(true);
  });
});
