/**
 * Unit tests for the C2/C3 structural checks added to content-quality-gate
 * (blog work order 2026-09-28):
 *   - verdict_box_first / cta_after_verdict_box (C2: answer first, pitch
 *     second — every identification or customer-question draft opens on
 *     BottomLineBox, and the early estimate/quote CTA comes after it)
 *   - photo_slots_licensed_only (C3: an identification draft's
 *     pest/sign/look-alike photos are a closed set of licensed URLs)
 *   (C2 next_steps / related_posts moved to content-guardrails — Codex r2)
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  checkVerdictBoxFirst,
  checkCtaAfterVerdictBox,
  checkPhotoSlotsLicensedOnly,
  collectBodyImageOccurrences,
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

  // Codex P1 (2nd round): a pitch-style link before the box worded
  // differently than "estimate"/"quote" must not be invisible to this
  // check — "answer first, pitch second" bars ANY link before the box,
  // not only estimate/quote-labelled ones.
  test('fails when a non-estimate/quote pitch link ("Book Now") sits before the verdict box', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '[Book Now](/contact/)\n\n<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
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

  // Codex P2 (2026-09-28): a NON-CTA link (no estimate/quote wording)
  // inside the box's own props was previously invisible to this check.
  test('fails when a non-CTA link (no estimate/quote wording) sits inside the box recommendation prop', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Yes." recommendation="See our [pest control guide](/pest-control-services/) for more." />\n\nFire ants sting.',
      },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('link_inside_verdict_box');
  });

  test('fails when a non-CTA link sits inside the box verdict prop', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Read [our guide](/pest-control-services/) first." recommendation="Call a pro." />',
      },
      brief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('link_inside_verdict_box');
  });

  test('passes when the same link is moved OUTSIDE the box, after it', () => {
    const r = checkCtaAfterVerdictBox(
      {
        frontmatter: { post_type: 'diagnostic' },
        body: '<BottomLineBox verdict="Yes." recommendation="Call a pro." />\n\nSee our [pest control guide](/pest-control-services/) for more.',
      },
      brief(),
    );
    expect(r.ok).toBe(true);
  });
});

// ── photo_slots_licensed_only ───────────────────────────────────────

// ── photo_slots_licensed_only ──────────────────────────────────────
// Every licensed photo carries the full catalog entry (the composer only
// ever attaches real PHOTO_LIBRARY entries) and the EXACT attribution line:
//   Photo: [credit](source_page) ([license](license_url))
const PHOTO_URL = 'https://upload.wikimedia.org/real-fire-ant.jpg';
const PHOTO = {
  url: PHOTO_URL,
  alt: 'fire ant',
  credit: 'Test Photographer',
  license: 'CC BY 2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0',
  source_page: 'https://commons.wikimedia.org/wiki/File:Real_fire_ant.jpg',
};
const ATTR = `Photo: [${PHOTO.credit}](${PHOTO.source_page}) ([${PHOTO.license}](${PHOTO.license_url}))`;
function photoBrief(photo = PHOTO, extra = []) {
  return brief({ voice_constraints: { photo_slots: [{ slot: 'pest', photo, flagged_for_human: false }, ...extra] } });
}
function diag(body, fm = {}) {
  return { frontmatter: { post_type: 'diagnostic', ...fm }, body };
}

describe('checkPhotoSlotsLicensedOnly', () => {
  test('defers on a non-diagnostic draft', () => {
    const r = checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '![a fire ant](https://example.com/ai-art.png)' }, brief());
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('not_identification_post');
  });

  test('a diagnostic draft with NO photo_slots on the brief still fails on any embedded image — never fails open (Codex P1)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag('![a fire ant](https://example.com/ai-art.png)'), brief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('a diagnostic draft with NO photo_slots and NO body image passes (nothing to enforce)', () => {
    expect(checkPhotoSlotsLicensedOnly(diag('Fire ants sting. Call a pro.'), brief()).ok).toBe(true);
  });

  test('fails when the body embeds an image URL NOT in the brief photo_slots (e.g. AI-generated art)', () => {
    const b = photoBrief(PHOTO, [{ slot: 'sign', photo: null, flagged_for_human: true }]);
    const r = checkPhotoSlotsLicensedOnly(diag('![a fire ant, ai generated](https://example.com/ai-art.png)'), b);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('passes when the licensed image and its exact attribution line are present', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${ATTR}`), photoBrief()).ok).toBe(true);
  });

  test('fails when a licensed URL is reused with a MISLABELED alt (Codex P1)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![a termite](${PHOTO_URL})\n\n${ATTR}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_alt_mismatch:/);
  });

  test('fails when the attribution line is dropped from the body (Codex P1)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  test('fails closed on a catalog entry missing any attribution field', () => {
    const { license_url: _drop, ...incomplete } = PHOTO;
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${ATTR}`), photoBrief(incomplete));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_catalog_entry_incomplete:/);
  });

  // Open item from r1 + Codex r2 on #5216: credit and license must be the
  // LINK TEXT of the exact instructed form, not just present somewhere.
  test.each([
    ['bare credit/license text, no links', `Photo: ${PHOTO.credit} (${PHOTO.license})`],
    ['bare URLs as prose', `Photo: ${PHOTO.credit} (${PHOTO.license}) ${PHOTO.source_page} ${PHOTO.license_url}`],
    ['links present but with generic link text', `Photo: [source](${PHOTO.source_page}) by ${PHOTO.credit}, [license](${PHOTO.license_url}) ${PHOTO.license}`],
    ['credit linked to the license deed (swapped destinations)', `Photo: [${PHOTO.credit}](${PHOTO.license_url}) ([${PHOTO.license}](${PHOTO.source_page}))`],
  ])('fails the exact-form check: %s', (_label, line) => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${line}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  // Codex r2 on #5216 ("Require visible licensed-photo attribution"): an
  // attribution only inside a comment or code is not visible to readers.
  test.each([
    ['an HTML comment', `<!-- ${ATTR} -->`],
    ['an MDX comment', `{/* ${ATTR} */}`],
    ['a fenced code block', '```\n' + ATTR + '\n```'],
    ['an inline code span', '`' + ATTR + '`'],
  ])('fails when the only attribution sits inside %s', (_label, hidden) => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${hidden}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  test('passes when a flagged slot is correctly omitted (no image for it at all)', () => {
    const b = photoBrief(PHOTO, [{ slot: 'look_alike', photo: null, flagged_for_human: true }]);
    expect(checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${ATTR}`), b).ok).toBe(true);
  });

  test('a raw <img> tag with an unlicensed src fails the gate (Codex P1 — raw <img> is explicitly accepted by content-guardrails)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag('<img src="https://ai-art.example.com/fake-fire-ant.png" alt="fire ant">'), brief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('a raw <img> tag whose src IS a licensed URL passes when alt/attribution match', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`<img src="${PHOTO_URL}" alt="fire ant">\n\n${ATTR}`), photoBrief()).ok).toBe(true);
  });

  test('a raw <img> srcset entry with an unlicensed URL fails the gate even when src is licensed', () => {
    const r = checkPhotoSlotsLicensedOnly(
      diag(`<img src="${PHOTO_URL}" srcset="https://ai-art.example.com/fake-2x.png 2x" alt="fire ant">\n\n${ATTR}`),
      photoBrief(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('a reference-style image (![alt][ref] + [ref]: url) with an unlicensed URL fails the gate', () => {
    const r = checkPhotoSlotsLicensedOnly(diag('![fire ant][pic]\n\n[pic]: https://ai-art.example.com/fake-fire-ant.png'), brief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unlicensed_or_unknown_identification_photo:/);
  });

  test('a reference-style image resolving to a licensed URL is rejected as an unsupported form (publisher cannot re-host it)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant][pic]\n\n${ATTR}\n\n[pic]: ${PHOTO_URL}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_unsupported_form:reference:/);
  });

  test('collapsed reference form (![alt][]) resolves via the alt text as the label, and is likewise rejected as unsupported', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant][]\n\n${ATTR}\n\n[fire ant]: ${PHOTO_URL}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_unsupported_form:reference:/);
  });

  test('incidental whitespace around the alt does not false-fail (matches the publisher)', () => {
    for (const body of [`![  fire ant  ](${PHOTO_URL})\n\n${ATTR}`, `<img src="${PHOTO_URL}" alt=" fire ant ">\n\n${ATTR}`]) {
      expect(checkPhotoSlotsLicensedOnly(diag(body), photoBrief()).ok).toBe(true);
    }
  });

  test('a licensed standalone <img> whose alt contains ">" passes (Codex P1 r11)', () => {
    const photo = { ...PHOTO, alt: 'workers can be > 1/4 inch' };
    expect(checkPhotoSlotsLicensedOnly(diag(`<img src="${PHOTO_URL}" alt="${photo.alt}">\n\n${ATTR}`), photoBrief(photo)).ok).toBe(true);
  });
});

// Codex P1 (7th round): the gate approves only placements the publisher's
// re-hosting pass can actually re-host — standalone on its own line.
describe('checkPhotoSlotsLicensedOnly — publishable placement', () => {
  test('a licensed image placed MID-PARAGRAPH fails with a clear reason (it would never be re-hosted)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`See the photo ![fire ant](${PHOTO_URL}) below.\n\n${ATTR}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`identification_photo_not_standalone:${PHOTO_URL}`);
  });

  test('the same licensed URL used once standalone AND once inline still fails (counted per occurrence)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${PHOTO_URL})\n\n${ATTR}\n\nAgain: ![fire ant](${PHOTO_URL}) here.`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`identification_photo_not_standalone:${PHOTO_URL}`);
  });

  test('a standalone inline image and a standalone <img> tag both pass', () => {
    for (const body of [`Intro.\n\n![fire ant](${PHOTO_URL})\n\n${ATTR}\n\nMore.`, `Intro.\n\n<img src="${PHOTO_URL}" alt="fire ant">\n\n${ATTR}\n\nMore.`]) {
      expect(checkPhotoSlotsLicensedOnly(diag(body), photoBrief()).ok).toBe(true);
    }
  });

  test('a standalone <img> carrying a srcset is rejected as unsupported (the publisher re-hosts src only)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`<img src="${PHOTO_URL}" srcset="${PHOTO_URL} 2x" alt="fire ant">\n\n${ATTR}`), photoBrief());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^identification_photo_unsupported_form:srcset:/);
  });
});

// Codex r2 on #5216 ("Allow preserved licensed images through diagnostic
// refreshes"): a refresh brief carries no photo_slots; the post's own
// re-hosted photos are grandfathered from the LIVE previous version.
describe('checkPhotoSlotsLicensedOnly — refresh grandfathering', () => {
  const LOCAL = '/images/blog/pest-control/fire-ants/body-1.webp';
  const refreshBrief = () => brief({ action_type: 'refresh_existing_page', page_type: 'refresh', voice_constraints: {} });
  const liveBody = `<BottomLineBox verdict="v" recommendation="r" />\n\nIntro.\n\n![fire ant](${LOCAL})\n\n${ATTR}\n\nMore.`;
  const ctx = (body = liveBody) => ({ previousVersion: { body }, liveFrontmatter: { post_type: 'diagnostic' } });

  test('a preserved local photo with its attribution passes', () => {
    const draft = diag(`<BottomLineBox verdict="v2" recommendation="r2" />\n\nNew intro.\n\n![fire ant](${LOCAL})\n\n${ATTR}\n\nNew more.`);
    expect(checkPhotoSlotsLicensedOnly(draft, refreshBrief(), ctx())).toEqual({ ok: true });
  });

  test('the preserved photo fails once its attribution is dropped', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\nNo credit.`), refreshBrief(), ctx());
    expect(r).toEqual({ ok: false, reason: `identification_photo_attribution_missing:${LOCAL}` });
  });

  test('the preserved photo fails when its attribution survives only in a comment', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\n<!-- ${ATTR} -->`), refreshBrief(), ctx());
    expect(r.ok).toBe(false);
  });

  test('grants are per occurrence — a second copy of the same local photo is unlicensed', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\n${ATTR}\n\n![fire ant](${LOCAL})`), refreshBrief(), ctx());
    expect(r).toEqual({ ok: false, reason: `unlicensed_or_unknown_identification_photo:${LOCAL}` });
  });

  test('a relabeled alt is not grandfathered', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![a termite](${LOCAL})\n\n${ATTR}`), refreshBrief(), ctx());
    expect(r.ok).toBe(false);
  });

  test('a local image the live body never carried (or carried without attribution) is not grandfathered', () => {
    const other = '/images/blog/pest-control/fire-ants/body-2.webp';
    expect(checkPhotoSlotsLicensedOnly(diag(`![fire ant](${other})\n\n${ATTR}`), refreshBrief(), ctx()).ok).toBe(false);
    const unattributed = ctx(`Intro.\n\n![fire ant](${LOCAL})\n\nMore.`);
    expect(checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\n${ATTR}`), refreshBrief(), unattributed).ok).toBe(false);
  });

  test('a live photo that only appeared inside a comment grants nothing', () => {
    const commented = ctx(`<!--\n![fire ant](${LOCAL})\n\n${ATTR}\n-->`);
    expect(checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\n${ATTR}`), refreshBrief(), commented).ok).toBe(false);
  });

  test('a new-post brief never grandfathers, even with a previousVersion in context', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![fire ant](${LOCAL})\n\n${ATTR}`), brief(), ctx());
    expect(r.ok).toBe(false);
  });
});

// Codex r2 on #5216 ("Classify refreshes using the retained live post
// type"): publishRefresh ships the LIVE frontmatter, so a refresh is judged
// by the live post_type, not the draft's.
describe('refresh classification uses the live post_type', () => {
  const refreshBrief = () => brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
  const noBoxBody = 'Intro prose first.\n\n<BottomLineBox verdict="v" recommendation="r" />';

  test('a refresh draft that omits post_type is still held to answer-first when the live post is diagnostic', () => {
    const draft = { frontmatter: {}, body: noBoxBody };
    const ctx = { liveFrontmatter: { post_type: 'diagnostic' } };
    expect(checkVerdictBoxFirst(draft, refreshBrief(), ctx)).toEqual({ ok: false, reason: 'verdict_box_not_first_block' });
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '![x](https://example.com/ai.png)' }, refreshBrief(), ctx).ok).toBe(false);
  });

  test('a refresh draft that CLAIMS diagnostic on a non-diagnostic live post is judged by the live type', () => {
    const draft = { frontmatter: { post_type: 'diagnostic' }, body: noBoxBody };
    expect(checkVerdictBoxFirst(draft, refreshBrief(), { liveFrontmatter: { post_type: 'how-to' } }).ok).toBe(true);
  });

  test('without a live frontmatter load the draft value is the fallback', () => {
    const draft = { frontmatter: { post_type: 'diagnostic' }, body: noBoxBody };
    expect(checkVerdictBoxFirst(draft, refreshBrief(), {}).ok).toBe(false);
  });

  test('a new post ignores liveFrontmatter entirely', () => {
    const draft = { frontmatter: { post_type: 'how-to' }, body: noBoxBody };
    expect(checkVerdictBoxFirst(draft, brief(), { liveFrontmatter: { post_type: 'diagnostic' } }).ok).toBe(true);
  });
});

describe('collectBodyImageOccurrences', () => {
  test('collects inline, reference-style, and raw <img> (incl. srcset) occurrences together', () => {
    const body = [
      '![inline alt](https://example.com/inline.jpg)',
      '',
      '![ref alt][myref]',
      '',
      '<img src="https://example.com/raw.jpg" srcset="https://example.com/raw-2x.jpg 2x" alt="raw alt">',
      '',
      '[myref]: https://example.com/ref.jpg',
    ].join('\n');
    const occurrences = collectBodyImageOccurrences(body);
    const urls = occurrences.map((o) => o.url).sort();
    expect(urls).toEqual([
      'https://example.com/inline.jpg',
      'https://example.com/raw-2x.jpg',
      'https://example.com/raw.jpg',
      'https://example.com/ref.jpg',
    ].sort());
  });
});

// C2 frontmatter next_steps / related_posts are judged by content-guardrails
// (content-guardrails-next-steps-related-posts.test.js), not a hard check here.
test('the quality gate no longer carries a separate next_steps/related_posts check', () => {
  const gate = require('../services/content/content-quality-gate');
  expect(gate._internals.checkNextStepsRelatedPostsClosedSet).toBeUndefined();
});

// Codex P1 (r10): the box-tag match must be quote-aware — a literal `>`
// inside a prop value used to truncate it, hiding a link later in the prop.
test('checkCtaAfterVerdictBox: a link after a literal ">" inside a box prop is still caught', () => {
  const r = checkCtaAfterVerdictBox(
    {
      frontmatter: { post_type: 'diagnostic' },
      body: '<BottomLineBox verdict="Workers can be > 1/4 inch long." recommendation="Book at [our page](/contact/)." />\n\nProse.',
    },
    brief(),
  );
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('link_inside_verdict_box');
});

