/**
 * LLM-confirmed single-subject photo slot (2026-09-30).
 *
 * The matcher in licensed-photo-library.js refuses every topic with an
 * and/or/from/not connector. Code still finds the CANDIDATE species for such
 * a topic; one FAST structured call may only CONFIRM it (single_subject ===
 * true AND species_slug === the candidate's catalog_slug). Everything else,
 * including any error, leaves the slot empty. The LLM is always mocked here.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const lib = require('../services/content/licensed-photo-library');
const { confirmPhotoSubject } = require('../services/content/photo-subject-confirmer');
const { ContentBriefBuilder } = require('../services/content/content-brief-builder');
const { checkPhotoSlotsLicensedOnly } = require('../services/content/content-quality-gate')._internals;

const FIRE_ANT = lib.PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant');
const confirms = (slug, single = true) => ({ ok: true, json: { single_subject: single, species_slug: slug } });

beforeEach(() => jest.resetAllMocks());

describe('connectorBlockedCandidate (code finds the candidate)', () => {
  test('a topic blocked ONLY by and/or/from/not names its one entry', () => {
    for (const topic of ['where do fire ants come from', 'fire ant signs and identification', 'fire ants or pests here', 'this is not a fire ant']) {
      expect(lib.matchSpecies(topic)).toBeNull();
    }
    expect(lib.connectorBlockedCandidate('where do fire ants come from')?.catalog_slug).toBe('fire-ant');
    expect(lib.connectorBlockedCandidate('fire ant signs and identification')?.catalog_slug).toBe('fire-ant');
  });

  test('no candidate when the topic matches today, or fails for any other reason', () => {
    expect(lib.connectorBlockedCandidate('fire ant identification florida')).toBeNull(); // matches today
    expect(lib.connectorBlockedCandidate('fire ants and ghost ants')).toBeNull(); // another catalog pest named
    expect(lib.connectorBlockedCandidate('fire ants and no-see-ums')).toBeNull();
    expect(lib.connectorBlockedCandidate('fire ants and other insects')).toBeNull(); // broad class after "other"
    expect(lib.connectorBlockedCandidate('fire ants or red ants')).toBeNull();
    expect(lib.connectorBlockedCandidate('fire ant vs huntsman spider')).toBeNull(); // two entries + hard word
    expect(lib.connectorBlockedCandidate('termite swarmers and moisture')).toBeNull(); // no entry
    expect(lib.connectorBlockedCandidate('')).toBeNull();
  });

  test('explicit comparison words and the -like suffix block outright, connector or not', () => {
    for (const topic of [
      'fire ants vs carpenter ants',
      'bugs that look like fire ants',
      'fire ant-like insects and how to spot them',
      'difference between fire ants and ghost ants',
      'fire ants versus something else from the yard',
      'are fire ants more dangerous than wasps and hornets',
      'fire ants mistaken for other bugs and pests',
      'what is confused with a fire ant and why',
      'fire ants instead of roaches or rats',
      'fire ants compared to termites',
    ]) {
      expect(lib.connectorBlockedCandidate(topic)).toBeNull();
    }
  });

  test('buildPhotoSlots honors a confirmed slug only when code still derives that candidate', () => {
    const topic = 'where do fire ants come from';
    expect(lib.buildPhotoSlots(topic).every((s) => s.photo === null)).toBe(true);
    const slots = lib.buildPhotoSlots(topic, { confirmedSlug: 'fire-ant' });
    expect(slots.find((s) => s.slot === 'pest').photo.src).toBe(FIRE_ANT.src);
    // Another species' slug never introduces that species.
    expect(lib.buildPhotoSlots(topic, { confirmedSlug: 'huntsman-spider' }).every((s) => s.photo === null)).toBe(true);
    // A comparison topic ignores even the right slug.
    expect(lib.buildPhotoSlots('fire ants vs carpenter ants', { confirmedSlug: 'fire-ant' }).every((s) => s.photo === null)).toBe(true);
    expect(lib.buildPhotoSlots('fire ants and ghost ants', { confirmedSlug: 'fire-ant' }).every((s) => s.photo === null)).toBe(true);
    expect(lib.findPhotoForSlot(topic, 'pest', { confirmedSlug: 'fire-ant' }).src).toBe(FIRE_ANT.src);
    expect(lib.findPhotoForSlot(topic, 'pest')).toBeNull();
  });
});

describe('confirmPhotoSubject (LLM may only confirm)', () => {
  const topic = 'where do fire ants come from';

  test('confirms on single_subject true + the candidate slug, through the registered lane and FAST structured policy', async () => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    await expect(confirmPhotoSubject(topic)).resolves.toEqual({ slug: 'fire-ant', confirmed_by: 'llm' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.fastStructured);
    expect(payload).toMatchObject({ laneId: 'photo_subject_confirm', jsonMode: true });
    expect(payload.text).toContain(topic);
    expect(payload.text).toContain('fire-ant');
    expect(payload).not.toHaveProperty('temperature');
    expect(options).toMatchObject({ reserveFallbackBudget: true });
    expect(options.validate({ json: { single_subject: true, species_slug: 'fire-ant' } })).toBeNull();
    expect(options.validate({ json: { single_subject: 'yes' } })).not.toBeNull();
  });

  test.each([
    ['single_subject false', confirms('fire-ant', false)],
    ['false with a null slug', confirms(null, false)],
    ['another slug', confirms('huntsman-spider')],
    ['true with a null slug', confirms(null)],
    ['a slug not in the catalog', confirms('red-imported-fire-ant')],
    ['a string instead of a boolean', { ok: true, json: { single_subject: 'true', species_slug: 'fire-ant' } }],
    ['malformed json', { ok: true, json: 'fire-ant' }],
    ['empty json', { ok: true, json: null }],
    ['a provider miss', { ok: false, reason: 'timeout' }],
  ])('no photo on %s', async (_label, reply) => {
    dispatchWithFallback.mockResolvedValue(reply);
    await expect(confirmPhotoSubject(topic)).resolves.toBeNull();
  });

  test('two-subject topics the code cannot see ("fire ants and gnats") reach the model, which declines', async () => {
    dispatchWithFallback.mockResolvedValue(confirms(null, false));
    await expect(confirmPhotoSubject('fire ants and gnats')).resolves.toBeNull();
    await expect(confirmPhotoSubject('this is not a fire ant')).resolves.toBeNull();
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
  });

  test('no photo when the call throws or the provider is unavailable', async () => {
    dispatchWithFallback.mockRejectedValue(new Error('provider unavailable'));
    await expect(confirmPhotoSubject(topic)).resolves.toBeNull();
    dispatchWithFallback.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    await expect(confirmPhotoSubject(topic)).resolves.toBeNull();
  });

  test.each([
    'fire ants and ghost ants',
    'fire ants and no-see-ums',
    'fire ants and other insects',
    'fire ants vs carpenter ants',
    'bugs that look like fire ants',
    'fire ant-like bugs and where they come from',
    'fire ant identification florida', // matches today: no call needed
    'termite swarmers and moisture', // no library entry
    '',
    null,
  ])('makes NO model call for %p', async (t) => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    await expect(confirmPhotoSubject(t)).resolves.toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('compose() resolves the confirmation before composing the brief', () => {
  const decision = (page_type = 'supporting-blog') => ({
    page_type, action_type: 'new_supporting_blog', final_score: 80, score_breakdown: {}, human_review_required: false, human_review_reason: null, router_notes: null,
  });
  async function composeFor(query, { pageType } = {}) {
    const queue = require('../services/content/opportunity-queue');
    const router = require('../services/content/decision-router');
    const opportunity = { id: 'opp-photo', page_url: null, query, service: 'pest', city: 'Bradenton', bucket: 'customer_need', signal_metadata: {} };
    const getById = jest.spyOn(queue, 'getById').mockResolvedValue(opportunity);
    const route = jest.spyOn(router, 'route').mockReturnValue(decision(pageType));
    try {
      const builder = new ContentBriefBuilder();
      builder._gatherSignals = jest.fn().mockResolvedValue({ customer_signal: null, serp_profile: null, conversion_feedback: null });
      builder._countExistingBriefs = jest.fn().mockResolvedValue(0);
      builder._loadFactsPack = jest.fn().mockResolvedValue(null);
      builder._loadRelatedPosts = jest.fn().mockResolvedValue([]);
      return await builder.compose(opportunity.id, { persist: false });
    } finally {
      getById.mockRestore();
      route.mockRestore();
    }
  }
  const pestPhoto = (brief) => brief.voice_constraints.photo_slots.find((s) => s.slot === 'pest').photo;

  test('"where do fire ants come from": LLM confirms -> pest slot filled and the subject recorded', async () => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    const brief = await composeFor('where do fire ants come from');
    expect(pestPhoto(brief).src).toBe(FIRE_ANT.src);
    expect(brief.voice_constraints.photo_subject).toEqual({ slug: 'fire-ant', confirmed_by: 'llm' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('customer-question pages get the same treatment', async () => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    const brief = await composeFor('fire ant signs and identification', { pageType: 'customer-question' });
    expect(pestPhoto(brief).src).toBe(FIRE_ANT.src);
  });

  test.each([
    ['single_subject false', confirms('fire-ant', false)],
    ['another slug', confirms('huntsman-spider')],
    ['a provider miss', { ok: false, reason: 'timeout' }],
  ])('no photo and no photo_subject when the LLM answers: %s', async (_label, reply) => {
    dispatchWithFallback.mockResolvedValue(reply);
    const brief = await composeFor('where do fire ants come from');
    expect(brief.voice_constraints.photo_slots.every((s) => s.photo === null && s.flagged_for_human)).toBe(true);
    expect(brief.voice_constraints.photo_subject).toBeUndefined();
  });

  test('a throwing call leaves the brief composing with no photo', async () => {
    dispatchWithFallback.mockRejectedValue(new Error('provider unavailable'));
    const brief = await composeFor('where do fire ants come from');
    expect(brief.voice_constraints.photo_slots.every((s) => s.photo === null)).toBe(true);
  });

  test.each(['fire ants and ghost ants', 'fire ants vs carpenter ants', 'bugs that look like fire ants'])('%s: no model call, no photo', async (q) => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    const brief = await composeFor(q);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(brief.voice_constraints.photo_slots.every((s) => s.photo === null)).toBe(true);
    expect(brief.voice_constraints.photo_subject).toBeUndefined();
  });

  test('a topic that matches today makes no call and builds the same slots as before', async () => {
    const brief = await composeFor('fire ant identification florida');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(brief.voice_constraints.photo_slots).toEqual(lib.buildPhotoSlots('fire ant identification florida'));
    expect(pestPhoto(brief).src).toBe(FIRE_ANT.src);
    expect(brief.voice_constraints.photo_subject).toBeUndefined();
  });

  test('non-identification page types make no call', async () => {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    const brief = await composeFor('where do fire ants come from', { pageType: 'city-service' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(brief.voice_constraints.photo_slots).toBeUndefined();
  });
});

describe('the draft-time gate judges the confirmed brief by its slots', () => {
  const ATTR = lib.photoAttributionLine(FIRE_ANT);
  const diag = (body) => ({ frontmatter: { post_type: 'diagnostic' }, body });

  async function confirmedBrief() {
    dispatchWithFallback.mockResolvedValue(confirms('fire-ant'));
    const topic = 'where do fire ants come from';
    const confirmed = await confirmPhotoSubject(topic);
    return {
      page_type: 'supporting-blog',
      action_type: 'new_supporting_blog',
      target_keyword: topic,
      voice_constraints: {
        photo_slots: lib.buildPhotoSlots(topic, { confirmedSlug: confirmed.slug }),
        photo_subject: confirmed,
      },
    };
  }

  test('accepts a draft embedding the confirmed photo with its exact attribution', async () => {
    const brief = await confirmedBrief();
    const populated = brief.voice_constraints.photo_slots.filter((s) => s.photo).map((s) => lib.libraryPhotoBySrc(s.photo.src));
    expect(populated.map((e) => e.catalog_slug)).toContain('fire-ant');
    const embeds = populated.map((e) => `![${e.alt}](${e.src})\n\n${lib.photoAttributionLine(e)}`).join('\n\n');
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${embeds}\n\nMore.`), brief, {})).toEqual({ ok: true });
    // The same draft without the pest photo it was assigned still fails (slots enforced).
    expect(checkPhotoSlotsLicensedOnly(diag('Intro only.'), brief, {}).reason).toMatch(/^identification_photo_slot_missing:/);
  });

  test('still rejects a library photo that is not one of the brief slots', async () => {
    const brief = await confirmedBrief();
    const roach = lib.PHOTO_LIBRARY.find((e) => e.catalog_slug === 'american-cockroach');
    const r = checkPhotoSlotsLicensedOnly(diag(`![${roach.alt}](${roach.src})\n\n${lib.photoAttributionLine(roach)}`), brief, {});
    expect(r).toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${roach.src}` });
  });

  test('an unconfirmed brief of the same topic still allows no library photo', async () => {
    const topic = 'where do fire ants come from';
    const brief = { page_type: 'supporting-blog', action_type: 'new_supporting_blog', target_keyword: topic, voice_constraints: { photo_slots: lib.buildPhotoSlots(topic) } };
    const r = checkPhotoSlotsLicensedOnly(diag(`![${FIRE_ANT.alt}](${FIRE_ANT.src})\n\n${ATTR}`), brief, {});
    expect(r).toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${FIRE_ANT.src}` });
  });
});
