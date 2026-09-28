/**
 * Regression test (C3, blog work order 2026-09-28 + Codex pre-push review):
 * without this, every licensed Commons photo/attribution the PHOTO SLOTS
 * writer instruction requires hard-fails content-guardrails'
 * DISALLOWED_EXTERNAL_LINK P0 — upload.wikimedia.org, commons.wikimedia.org
 * and creativecommons.org are not on the trusted-citation-host allowlist.
 * deriveSyncGuardrailOptions must thread the brief's photo_slots URLs into
 * requiredSourceUrls, the same exact-URL allowance operator citations use,
 * so the gate accepts exactly the licensed URLs the brief supplied.
 */

jest.mock('../models/db', () => jest.fn());

const { deriveSyncGuardrailOptions } = require('../services/content/guardrail-options');
const { evaluate } = require('../services/content/content-guardrails');

const PHOTO_SLOTS = [
  {
    slot: 'pest',
    caption: 'A clear photo of the fire ant itself.',
    flagged_for_human: false,
    photo: {
      url: 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg',
      source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg',
      alt: 'Red imported fire ant workers swarming over sandy soil in Florida',
      license: 'CC BY 2.0',
      license_url: 'https://creativecommons.org/licenses/by/2.0',
      credit: 'Judy Gallagher',
    },
  },
  { slot: 'sign', caption: 'A photo of the mound.', flagged_for_human: true, photo: null },
  { slot: 'look_alike', caption: 'A look-alike.', flagged_for_human: true, photo: null },
];

describe('deriveSyncGuardrailOptions — photo_slots requiredSourceUrls allowance', () => {
  test('carries every populated slot photo URL (url + source_page + license_url) into requiredSourceUrls', () => {
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', voice_constraints: { photo_slots: PHOTO_SLOTS } },
    );
    expect(opts.requiredSourceUrls).toEqual(expect.arrayContaining([
      'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg',
      'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg',
      'https://creativecommons.org/licenses/by/2.0',
    ]));
  });

  test('a flagged (photo: null) slot contributes nothing — no undefined/null entries', () => {
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', voice_constraints: { photo_slots: PHOTO_SLOTS } },
    );
    expect(opts.requiredSourceUrls.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);
  });

  test('no photo_slots on the brief leaves requiredSourceUrls unaffected', () => {
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', voice_constraints: {} },
    );
    expect(opts.requiredSourceUrls).toEqual([]);
  });

  test('end-to-end: a diagnostic draft embedding the licensed photo + attribution links clears content-guardrails.evaluate (no DISALLOWED_EXTERNAL_LINK)', () => {
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need', service: 'pest' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', service: 'pest', voice_constraints: { photo_slots: PHOTO_SLOTS } },
    );
    const body = [
      '<BottomLineBox verdict="Yes, fire ants sting." recommendation="Keep pets and kids off the mound." />',
      '',
      'Fire ants build loose sandy mounds in open, sunny Florida yards.',
      '',
      '![Red imported fire ant workers swarming over sandy soil in Florida](https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg)',
      '',
      'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg) ([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
    ].join('\n');
    const result = evaluate({ frontmatter: { post_type: 'diagnostic' }, body }, opts);
    const externalLinkFailures = result.findings.filter((f) => f.code === 'DISALLOWED_EXTERNAL_LINK');
    expect(externalLinkFailures).toEqual([]);
  });

  test('requiredSourceUrls is allowance-only: a draft that never embeds any photo_slots photo is never penalized for skipping them (Codex P1 double-check)', () => {
    // Photo slots ride on EVERY supporting-blog/customer-question brief
    // unconditionally (the writer decides post_type, not the composer) — a
    // non-diagnostic draft, or one where every slot came back flagged, must
    // never be treated as though it owed a citation to an unused photo URL.
    const opts = deriveSyncGuardrailOptions(
      { id: 'opp-1', bucket: 'customer_need', service: 'pest' },
      { action_type: 'new_supporting_blog', page_type: 'supporting-blog', service: 'pest', voice_constraints: { photo_slots: PHOTO_SLOTS } },
    );
    const body = 'Fire ants build loose sandy mounds in open, sunny Florida yards. Learn more on the Waves blog.';
    const result = evaluate({ frontmatter: { post_type: 'decision' }, body }, opts);
    const photoRelatedFailures = result.findings.filter((f) => /photo|MISSING_SOURCE|REQUIRED_SOURCE/i.test(`${f.code} ${f.message}`));
    expect(photoRelatedFailures).toEqual([]);
  });
});
