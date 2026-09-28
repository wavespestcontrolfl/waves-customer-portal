/**
 * Unit tests for the C2/C3 structural checks added to content-quality-gate
 * (blog work order 2026-09-28):
 *   - verdict_box_first / cta_after_verdict_box (C2: answer first, pitch
 *     second — every identification or customer-question draft opens on
 *     BottomLineBox, and the early estimate/quote CTA comes after it)
 *   - photo_slots_licensed_only (C3: an identification draft's
 *     pest/sign/look-alike photos are a closed set of licensed URLs)
 *   - next_steps_related_posts_closed_set (C2: optional frontmatter
 *     fields, never a minimum, but every href/path must be verified)
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  checkVerdictBoxFirst,
  checkCtaAfterVerdictBox,
  checkPhotoSlotsLicensedOnly,
  checkNextStepsRelatedPostsClosedSet,
} = require('../services/content/content-quality-gate')._internals;

function brief(overrides = {}) {
  return {
    page_type: 'supporting-blog',
    city: 'Bradenton',
    service: 'pest',
    target_keyword: 'fire ant identification',
    internal_links_to_add: [],
    voice_constraints: {},
    ...overrides,
  };
}

// ── verdict_box_first ──────────────────────────────────────────────

describe('checkVerdictBoxFirst', () => {
  test('defers on a non-identification, non-customer-question draft', () => {
    const r = checkVerdictBoxFirst({ frontmatter: {}, body: 'Ants are common in Florida.' }, brief({ page_type: 'city-service' }));
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('not_identification_or_question');
  });

  test('fails a diagnostic draft with no verdict box at all', () => {
    const r = checkVerdictBoxFirst(
      { frontmatter: { post_type: 'diagnostic' }, body: 'Fire ants build sandy mounds in open yards.' },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verdict_box_not_first_block');
  });

  test('fails a diagnostic draft where the verdict box is present but NOT first', () => {
    const r = checkVerdictBoxFirst(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: 'Fire ants are common in Florida yards.\n\n<BottomLineBox verdict="Yes, they can sting." recommendation="Avoid the mound." />',
      },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verdict_box_not_first_block');
  });

  test('passes a diagnostic draft that opens on the verdict box', () => {
    const r = checkVerdictBoxFirst(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Yes, fire ants sting and it hurts." recommendation="Keep pets and kids off the mound; call a pro for full-yard treatment." />\n\nFire ants build loose sandy mounds in open, sunny yards.',
      },
      brief(),
    );
    expect(r.ok).toBe(true);
  });

  test('applies to customer-question pages regardless of post_type', () => {
    const r = checkVerdictBoxFirst(
      { frontmatter: {}, body: 'Yes, fire ants can sting multiple times.' },
      brief({ page_type: 'customer-question' }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verdict_box_not_first_block');
  });

  test('fails closed on an empty body', () => {
    const r = checkVerdictBoxFirst({ frontmatter: { post_type: 'diagnostic' }, body: '' }, brief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty_body');
  });
});

// ── cta_after_verdict_box ──────────────────────────────────────────

describe('checkCtaAfterVerdictBox', () => {
  test('defers on a non-identification, non-customer-question draft', () => {
    const r = checkCtaAfterVerdictBox({ frontmatter: {}, body: '[Get a Free Quote](/contact/)' }, brief({ page_type: 'city-service' }));
    expect(r.ok).toBe(true);
  });

  test('defers when no verdict box is present (verdict_box_first already fails that)', () => {
    const r = checkCtaAfterVerdictBox(
      { frontmatter: { post_type: 'diagnostic' }, body: '[Get a Free Estimate](/contact/)' },
      brief(),
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_verdict_box_present');
  });

  test('fails when the CTA link is BEFORE the verdict box', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '[Get a Free Estimate](/contact/)\n\n<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cta_before_verdict_box');
  });

  test('passes when the CTA link comes AFTER the verdict box', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Yes." recommendation="Call a pro." />\n\nFire ants sting. [Get a Free Estimate](/contact/) for full-yard treatment.',
      },
      brief(),
    );
    expect(r.ok).toBe(true);
  });

  test('passes when there is no CTA link at all (other gates own CTA presence)', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Yes." recommendation="Call a pro." />\n\nFire ants sting.',
      },
      brief(),
    );
    expect(r.ok).toBe(true);
  });
});

// ── photo_slots_licensed_only ───────────────────────────────────────

describe('checkPhotoSlotsLicensedOnly', () => {
  test('defers on a non-diagnostic draft', () => {
    const r = checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '![a fire ant](https://example.com/ai-art.png)' }, brief());
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('not_identification_post');
  });

  test('a diagnostic draft with NO photo_slots on the brief still fails on any embedded image — never fails open (Codex P1)', () => {
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![a fire ant](https://example.com/ai-art.png)' },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('a diagnostic draft with NO photo_slots and NO body image passes (nothing to enforce)', () => {
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: 'Fire ants sting. Call a pro.' },
      brief(),
    );
    expect(r.ok).toBe(true);
  });

  test('fails when the body embeds an image URL NOT in the brief photo_slots (e.g. AI-generated art)', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant' }, flagged_for_human: false },
          { slot: 'sign', photo: null, flagged_for_human: true },
          { slot: 'look_alike', photo: null, flagged_for_human: true },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![a fire ant, ai generated](https://example.com/ai-art.png)' },
      b,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('passes when every embedded image URL is one of the brief photo_slots', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant' }, flagged_for_human: false },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)\n\nPhoto: Judy Gallagher (CC BY 2.0)' },
      b,
    );
    expect(r.ok).toBe(true);
  });

  test('fails when a licensed URL is reused with a MISLABELED alt (Codex P1)', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant', credit: 'Judy Gallagher', license: 'CC BY 2.0' }, flagged_for_human: false },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      // Real fire-ant URL, but relabeled as a termite — the URL alone must not vouch for the caption.
      { frontmatter: { post_type: 'diagnostic' }, body: '![a termite](https://upload.wikimedia.org/real-fire-ant.jpg)\n\nPhoto: Judy Gallagher (CC BY 2.0)' },
      b,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_alt_mismatch:/);
  });

  test('fails when the credit/license attribution is dropped from the body (Codex P1)', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant', credit: 'Judy Gallagher', license: 'CC BY 2.0' }, flagged_for_human: false },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)' },
      b,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_credit_missing:/);
  });

  test('passes when alt, credit, and license all match the catalog entry exactly', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant', credit: 'Judy Gallagher', license: 'CC BY 2.0' }, flagged_for_human: false },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)\n\nPhoto: Judy Gallagher (CC BY 2.0)' },
      b,
    );
    expect(r.ok).toBe(true);
  });

  test('fails when the catalog entry has a license_url/source_page but the body carries only bare text (Codex P1: CC requires a link)', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          {
            slot: 'pest',
            photo: {
              url: 'https://upload.wikimedia.org/real-fire-ant.jpg',
              alt: 'fire ant',
              credit: 'Judy Gallagher',
              license: 'CC BY 2.0',
              license_url: 'https://creativecommons.org/licenses/by/2.0',
              source_page: 'https://commons.wikimedia.org/wiki/File:Real_Fire_Ant.jpg',
            },
            flagged_for_human: false,
          },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      // Credit + license text present, but neither is an actual link.
      { frontmatter: { post_type: 'diagnostic' }, body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)\n\nPhoto: Judy Gallagher (CC BY 2.0)' },
      b,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_(license_link|source_link)_missing:/);
  });

  test('passes when the license and source page are linked as the writer instruction requires', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          {
            slot: 'pest',
            photo: {
              url: 'https://upload.wikimedia.org/real-fire-ant.jpg',
              alt: 'fire ant',
              credit: 'Judy Gallagher',
              license: 'CC BY 2.0',
              license_url: 'https://creativecommons.org/licenses/by/2.0',
              source_page: 'https://commons.wikimedia.org/wiki/File:Real_Fire_Ant.jpg',
            },
            flagged_for_human: false,
          },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)\n\n'
          + 'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Real_Fire_Ant.jpg) '
          + '([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
      },
      b,
    );
    expect(r.ok).toBe(true);
  });

  test('passes when a flagged slot is correctly omitted (no image for it at all)', () => {
    const b = brief({
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: 'https://upload.wikimedia.org/real-fire-ant.jpg', alt: 'fire ant' }, flagged_for_human: false },
          { slot: 'look_alike', photo: null, flagged_for_human: true },
        ],
      },
    });
    const r = checkPhotoSlotsLicensedOnly(
      { frontmatter: { post_type: 'diagnostic' }, body: '![fire ant](https://upload.wikimedia.org/real-fire-ant.jpg)' },
      b,
    );
    expect(r.ok).toBe(true);
  });
});

// ── next_steps_related_posts_closed_set ─────────────────────────────

describe('checkNextStepsRelatedPostsClosedSet', () => {
  test('passes when neither field is present (fully optional)', () => {
    const r = checkNextStepsRelatedPostsClosedSet({ frontmatter: {} }, brief());
    expect(r.ok).toBe(true);
  });

  test('fails closed when next_steps is a non-array value instead of being silently ignored (Codex P1)', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: { label: 'Get an estimate', href: '/contact/' } } },
      brief({ internal_links_to_add: ['/contact/'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('next_steps_not_an_array');
  });

  test('fails closed when related_posts is a non-array value instead of being silently ignored (Codex P1)', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { related_posts: '/pest-control/made-up-post/' } },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('related_posts_not_an_array');
  });

  test('fails when next_steps has more than 4 entries', () => {
    const nextSteps = Array.from({ length: 5 }, (_, i) => ({ label: `Step ${i}`, href: '/contact/' }));
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: nextSteps } },
      brief({ internal_links_to_add: ['/contact/'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('next_steps_exceeds_max_4');
  });

  test('fails an off-site absolute URL even when its PATH matches an allowed route (Codex P1)', () => {
    // https://unrelated.example/contact/ must never pass just because its
    // pathname happens to match a real allowed path on OUR site.
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: [{ label: 'Contact us', href: 'https://unrelated.example/contact/' }] } },
      brief({ internal_links_to_add: ['/contact/'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^next_steps_entry_not_verified:/);
  });

  test('passes an absolute URL on the real hub host matching an allowed route', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: [{ label: 'Contact us', href: 'https://www.wavespestcontrol.com/contact/' }] } },
      brief({ internal_links_to_add: ['/contact/'] }),
    );
    expect(r.ok).toBe(true);
  });

  test('fails when a related_posts entry is not on the brief-verified list', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { related_posts: ['/pest-control/made-up-post/'] } },
      brief({ voice_constraints: { related_posts: [{ path: '/pest-control/real-post/' }] } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^related_posts_entry_not_verified:/);
  });

  test('passes when a related_posts entry matches a brief-verified related-post path', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { related_posts: ['/pest-control/real-post/'] } },
      brief({ voice_constraints: { related_posts: [{ path: '/pest-control/real-post/' }] } }),
    );
    expect(r.ok).toBe(true);
  });

  test('fails when a next_steps href is not on the closed set', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: [{ label: 'Found a live one?', href: '/made-up-route/' }] } },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^next_steps_entry_not_verified:/);
  });

  test('passes when a next_steps href is in internal_links_to_add', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: [{ label: 'Get an estimate', href: '/pest-control-calculator/' }] } },
      brief({ internal_links_to_add: ['/pest-control-calculator/'] }),
    );
    expect(r.ok).toBe(true);
  });

  test('fails when a next_steps entry is missing a label or href', () => {
    const r = checkNextStepsRelatedPostsClosedSet(
      { frontmatter: { next_steps: [{ href: '/contact/' }] } },
      brief({ internal_links_to_add: ['/contact/'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('next_steps_entry_missing_label_or_href');
  });
});
