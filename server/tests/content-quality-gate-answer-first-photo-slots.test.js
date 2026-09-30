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
  // Codex r6 on #5216 ("Validate diagnostic verdict content before
  // publishing"): an identification post's box answers "Is it dangerous?"
  // and "What to do now", not just sits first.
  test('a diagnostic box must answer "Is it dangerous?" and give a next step', () => {
    const run = (props) => checkVerdictBoxFirst({ frontmatter: { post_type: 'diagnostic' }, body: `<BottomLineBox ${props} />\n\nMore.` }, brief());
    expect(run('verdict="Professional help is available." recommendation="Request an estimate."'))
      .toEqual({ ok: false, reason: 'verdict_does_not_answer_is_it_dangerous' });
    expect(run('verdict="Mostly harmless to people." recommendation="Leave it alone."')).toEqual({ ok: true });
    expect(run('verdict="Their stings burn and can blister." recommendation="Keep kids off the mound."')).toEqual({ ok: true });
    expect(run('verdict="No, it is not dangerous."')).toEqual({ ok: false, reason: 'verdict_box_has_no_recommendation' });
    expect(run('recommendation="Leave it alone."')).toEqual({ ok: false, reason: 'verdict_box_has_no_verdict' });
  });

  test('a customer-question box is judged against its own question elsewhere, not "Is it dangerous?"', () => {
    const r = checkVerdictBoxFirst({ frontmatter: {}, body: '<BottomLineBox verdict="About six weeks." recommendation="Seal the gaps." />\n\nMore.' }, brief({ page_type: 'customer-question' }));
    expect(r).toEqual({ ok: true });
  });

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
// Codex r3 on #5216: identification photos are licensed-library files
// already committed in the Astro repo, embedded by LOCAL path. The gate
// looks each image up in the library by src — the same answer for a new
// post, a refresh and a remediation revalidation, with no brief data.
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');
const PHOTO = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant');
const PHOTO_URL = PHOTO.src;
const ATTR = photoAttributionLine(PHOTO);
function diag(body, fm = {}) {
  return { frontmatter: { post_type: 'diagnostic', ...fm }, body };
}
// A brief whose photo_slots assign the given library photos.
function slotsBrief(photos = [PHOTO], extra = {}) {
  return brief({ voice_constraints: { photo_slots: photos.map((p, i) => ({ slot: ['pest', 'sign', 'look_alike'][i], photo: { src: p.src, alt: p.alt, credit: p.credit, source_page: p.source_page, license: p.license, license_url: p.license_url } })) }, ...extra });
}

describe('checkPhotoSlotsLicensedOnly', () => {
  test('defers on a non-diagnostic draft', () => {
    const r = checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '![a fire ant](https://example.com/ai-art.png)' }, brief());
    expect(r).toEqual({ ok: true, reason: 'not_identification_post' });
  });

  test('a diagnostic draft with no image passes (nothing to enforce)', () => {
    expect(checkPhotoSlotsLicensedOnly(diag('Fire ants sting. Call a pro.'), brief()).ok).toBe(true);
  });

  test.each([
    ['AI art', 'https://example.com/ai-art.png'],
    ['the remote Commons original of a library photo', 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg'],
    ['a generated body image', '/images/blog/pest-control/fire-ant-id/body-1.webp'],
    ['a library path on an absolute URL', `https://www.wavespestcontrol.com${PHOTO_URL}`],
  ])('fails on %s', (_label, url) => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${url})\n\n${ATTR}`), brief());
    expect(r).toEqual({ ok: false, reason: `unlicensed_or_unknown_identification_photo:${url}` });
  });

  test('passes a library photo the brief assigned, with its catalog alt and exact attribution line', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}\n\nMore.`), slotsBrief())).toEqual({ ok: true });
  });

  test('passes every library photo the same way when its brief assigns it', () => {
    for (const photo of PHOTO_LIBRARY) {
      const r = checkPhotoSlotsLicensedOnly(diag(`![${photo.alt}](${photo.src})\n\n${photoAttributionLine(photo)}`), slotsBrief([photo]));
      expect(r).toEqual({ ok: true });
    }
  });

  // Codex r4 on #5216 ("Restrict diagnostic photos to the brief's slots").
  test('a fire-ant brief embedding the cockroach photo fails, even fully attributed', () => {
    const roach = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'american-cockroach');
    const r = checkPhotoSlotsLicensedOnly(diag(`![${roach.alt}](${roach.src})\n\n${photoAttributionLine(roach)}`), slotsBrief([PHOTO]));
    expect(r).toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${roach.src}` });
  });

  test('a new post whose brief has no photo slots may embed no library photo', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`), brief());
    expect(r).toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${PHOTO_URL}` });
  });

  test('refresh: a library photo the live body already showed is kept; a new one is not', () => {
    const refresh = brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
    const live = `Old intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
    const ctx = (prior) => ({ liveFrontmatter: { post_type: 'diagnostic' }, previousVersion: { body: prior } });
    const kept = `<BottomLineBox verdict="v" recommendation="r" />\n\nNew intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: kept }, refresh, ctx(live))).toEqual({ ok: true });
    const mound = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant-mound');
    const added = `${kept}\n\n![${mound.alt}](${mound.src})\n\n${photoAttributionLine(mound)}`;
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: added }, refresh, ctx(live)))
      .toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${mound.src}` });
    // A photo that sat only in a comment of the live body grants nothing.
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: kept }, refresh, ctx(`<!-- ${live} -->`)).ok).toBe(false);
  });

  // Codex r5 on #5216 ("Require populated photo slots to appear in the draft").
  test('a new post must embed every photo its brief populated; null slots may stay empty', () => {
    const mound = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant-mound');
    const both = slotsBrief([PHOTO, mound]);
    const pest = `![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
    const sign = `![${mound.alt}](${mound.src})\n\n${photoAttributionLine(mound)}`;
    expect(checkPhotoSlotsLicensedOnly(diag('Fire ants sting. Call a pro.'), both))
      .toEqual({ ok: false, reason: `identification_photo_slot_missing:pest:${PHOTO_URL}` });
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${pest}`), both))
      .toEqual({ ok: false, reason: `identification_photo_slot_missing:sign:${mound.src}` });
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${pest}\n\n${sign}`), both)).toEqual({ ok: true });
    // A slot the library could not fill (photo: null) is not required.
    const withNull = brief({ voice_constraints: { photo_slots: [...both.voice_constraints.photo_slots, { slot: 'look_alike', photo: null }] } });
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${pest}\n\n${sign}`), withNull)).toEqual({ ok: true });
    // A photo that appears only inside a comment does not count as shown.
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${pest}\n\n<!-- ${sign} -->`), both).ok).toBe(false);
  });

  // Codex r6 on #5216 ("Exclude hidden HTML from photo attribution checks").
  test('an attribution inside a definitely-hidden container does not count', () => {
    const body = `Intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n<div hidden>\n\n${ATTR}\n\n</div>`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief()))
      .toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
  });

  test('a slot photo inside a hidden container is not shown', () => {
    const body = `Intro.\n\n<div style="display:none">\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n</div>\n\n${ATTR}`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief()))
      .toEqual({ ok: false, reason: `identification_photo_slot_missing:pest:${PHOTO_URL}` });
  });

  test('a refresh is never required to add a slot photo', () => {
    const refresh = slotsBrief([PHOTO], { action_type: 'refresh_existing_page', page_type: 'refresh' });
    const ctx = { liveFrontmatter: { post_type: 'diagnostic' }, previousVersion: { body: 'Old intro.' } };
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '<BottomLineBox verdict="v" recommendation="r" />\n\nNew intro.' }, refresh, ctx)).toEqual({ ok: true });
  });

  test('remediation revalidation re-runs with the run\'s own stored brief, so its slots apply', () => {
    const body = `<BottomLineBox verdict="v" recommendation="r" />\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief([PHOTO], { action_type: 'new_supporting_blog' }))).toEqual({ ok: true });
  });

  test('fails when a library photo carries a MISLABELED alt (Codex P1)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![a termite](${PHOTO_URL})\n\n${ATTR}`), brief());
    expect(r).toEqual({ ok: false, reason: `identification_photo_alt_mismatch:${PHOTO_URL}` });
  });

  test('fails when the attribution line is dropped', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${PHOTO_URL})`), brief()))
      .toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
  });

  test('another photo\'s attribution does not cover this one', () => {
    const other = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'wolf-spider');
    const r = checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${PHOTO_URL})\n\n${photoAttributionLine(other)}`), brief());
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  // Credit and license must be the LINK TEXT of the exact instructed form.
  test.each([
    ['bare credit/license text, no links', `Photo: ${PHOTO.credit} (${PHOTO.license})`],
    ['bare URLs as prose', `Photo: ${PHOTO.credit} (${PHOTO.license}) ${PHOTO.source_page} ${PHOTO.license_url}`],
    ['links with generic link text', `Photo: [source](${PHOTO.source_page}) by ${PHOTO.credit}, [license](${PHOTO.license_url}) ${PHOTO.license}`],
    ['swapped destinations', `Photo: [${PHOTO.credit}](${PHOTO.license_url}) ([${PHOTO.license}](${PHOTO.source_page}))`],
  ])('fails the exact-form check: %s', (_label, line) => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${PHOTO_URL})\n\n${line}`), brief());
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  // Codex r2: an attribution only inside a comment or code is not visible.
  test.each([
    ['an HTML comment', `<!-- ${ATTR} -->`],
    ['an MDX comment', `{/* ${ATTR} */}`],
    ['a fenced code block', '```\n' + ATTR + '\n```'],
    ['an inline code span', '`' + ATTR + '`'],
  ])('fails when the only attribution sits inside %s', (_label, hidden) => {
    const r = checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}](${PHOTO_URL})\n\n${hidden}`), brief());
    expect(r.reason).toBe(`identification_photo_attribution_missing:${PHOTO_URL}`);
  });

  test('a raw <img> of a library photo is rejected (the publisher parks raw <img>)', () => {
    const r = checkPhotoSlotsLicensedOnly(diag(`<img src="${PHOTO_URL}" alt="${PHOTO.alt}">\n\n${ATTR}`), brief());
    expect(r).toEqual({ ok: false, reason: `identification_photo_unsupported_form:img:${PHOTO_URL}` });
  });

  test('a raw <img> with an unlicensed src or srcset fails', () => {
    expect(checkPhotoSlotsLicensedOnly(diag('<img src="https://ai-art.example.com/x.png" alt="fire ant">'), brief()).reason)
      .toMatch(/^unlicensed_or_unknown_identification_photo:/);
    expect(checkPhotoSlotsLicensedOnly(diag(`<img src="${PHOTO_URL}" srcset="https://ai-art.example.com/x-2x.png 2x" alt="${PHOTO.alt}">\n\n${ATTR}`), brief()).ok)
      .toBe(false);
  });

  // Codex r5 on #5216 ("Scan shortcut-reference images before licensing
  // approval"): the gate's set of Markdown images is now the publisher's own
  // bodyImageRefs — which validateBodyImageRefs (the publish-time check)
  // accepts equally for inline, full/collapsed reference, and shortcut
  // forms — so a library photo in any of those forms now PASSES here too;
  // only a raw <img> (outside the publisher's Markdown subset) still fails
  // with the unsupported-form reason.
  test('reference-style and shortcut images: unlicensed fails as unlicensed, a library photo in the brief slots passes', () => {
    expect(checkPhotoSlotsLicensedOnly(diag('![fire ant][pic]\n\n[pic]: https://ai-art.example.com/x.png'), brief()).reason)
      .toMatch(/^unlicensed_or_unknown_identification_photo:/);
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}][pic]\n\n${ATTR}\n\n[pic]: ${PHOTO_URL}`), slotsBrief()))
      .toEqual({ ok: true });
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}][]\n\n${ATTR}\n\n[${PHOTO.alt}]: ${PHOTO_URL}`), slotsBrief()))
      .toEqual({ ok: true });
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}]\n\n${ATTR}\n\n[${PHOTO.alt}]: ${PHOTO_URL}`), slotsBrief()))
      .toEqual({ ok: true });
    // Still not in ANY brief's slots → the ordinary not-in-slots reason,
    // not an unsupported-form one.
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}][pic]\n\n${ATTR}\n\n[pic]: ${PHOTO_URL}`), brief()))
      .toEqual({ ok: false, reason: `identification_photo_not_in_brief_slots:${PHOTO_URL}` });
  });

  test('incidental whitespace around the alt does not false-fail', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`![  ${PHOTO.alt}  ](${PHOTO_URL})\n\n${ATTR}`), slotsBrief()).ok).toBe(true);
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

  test('a failed live frontmatter load fails CLOSED: the refresh is held to the identification checks', () => {
    const draft = { frontmatter: { post_type: 'how-to' }, body: noBoxBody };
    expect(checkVerdictBoxFirst(draft, refreshBrief(), { liveFrontmatterUnavailable: true }).ok).toBe(false);
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body: '![x](https://example.com/ai.png)' }, refreshBrief(), { liveFrontmatterUnavailable: true }).ok).toBe(false);
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


// Codex r3 on #5216 ("Redact PII from next-step fields"): next_steps render
// publicly, so the existing redaction gate scans each entry as the SAME
// "[label](href)" text the guardrails synthesize — label and href, with the
// query string decoded. Synthetic values only (no real customer data).
describe('next_steps PII scan (common hard check, next_steps only)', () => {
  const gate = require('../services/content/content-quality-gate');
  const { checkRedactionPassed, checkNextStepsRedacted } = gate._internals;
  const BODY = [
    '## What Fire Ants Look Like',
    '',
    'Red imported fire ants are small, reddish-brown ants that build loose mounds of sandy soil in sunny lawns. When the mound is disturbed, workers pour out and sting repeatedly.',
    '',
    '## When to Call',
    '',
    'If you see mounds near play areas or along walkways, treat them before the colony spreads. Our team handles fire ants across Sarasota and Manatee counties.',
  ].join('\n');
  const run = (step) => checkNextStepsRedacted({ body: BODY, frontmatter: { next_steps: [step] } });

  test('the body alone is clean (baseline)', () => {
    expect(checkRedactionPassed({ body: BODY, frontmatter: {} })).toEqual({ ok: true });
  });

  test.each([
    ['a name in the label', { label: 'Call Jane Doe', href: '/contact/' }, 'unredacted_name_in_next_steps'],
    ['an email in the label', { label: 'Email jane.doe@example.com', href: '/contact/' }, 'email_in_next_steps'],
    ['a phone in the label', { label: 'Text 941-555-0199', href: '/contact/' }, 'non_business_phone_number_in_next_steps:9415550199'],
    ['an address in the label', { label: 'Visit 4867 Maple Street', href: '/contact/' }, 'unredacted_address_in_next_steps'],
    ['a name in the href query', { label: 'Get a quote', href: '/contact/?name=Jane+Doe' }, 'unredacted_name_in_next_steps'],
    ['a lowercase name in the href query', { label: 'Get a quote', href: '/contact/?name=jane%20doe' }, 'unredacted_name_in_next_steps'],
    ['an email in the href query', { label: 'Get a quote', href: '/contact/?email=jane.doe%40example.com' }, 'email_in_next_steps'],
    ['a phone in the href query', { label: 'Get a quote', href: '/contact/?phone=9415550199' }, 'non_business_phone_number_in_next_steps:9415550199'],
    ['an address in the href query', { label: 'Get a quote', href: '/contact/?address=4867+Maple+Street' }, 'unredacted_address_in_next_steps'],
  ])('fails on %s', (_label, step, reason) => {
    expect(run(step)).toEqual({ ok: false, reason });
  });

  test('ordinary next-step labels and paths pass', () => {
    const steps = [
      { label: 'Found a live one?', href: '/contact/' },
      { label: 'Get a free estimate', href: '/free-estimate/' },
      { label: 'Seeing the damage, not the pest?', href: '/pest-control/' },
    ];
    expect(checkNextStepsRedacted({ body: BODY, frontmatter: { next_steps: steps } })).toEqual({ ok: true });
  });

  // Codex r5 on #5216 ("Skip draft next-step PII checks on refreshes"):
  // publishRefresh keeps the LIVE frontmatter and ships only the title/meta
  // fields, so a refresh draft's own next_steps never publish — scanning
  // them can only park a clean refresh on text that never ships.
  test('a refresh draft with PII in next_steps is skipped (its next_steps never publish)', () => {
    const dirty = { body: BODY, frontmatter: { next_steps: [{ label: 'Call Jane Doe', href: '/contact/' }] } };
    expect(checkNextStepsRedacted(dirty, { action_type: 'refresh_existing_page' }))
      .toEqual({ ok: true, reason: 'refresh_frontmatter_not_published' });
  });

  test('a non-refresh draft with the same PII still fails (the skip is refresh-only)', () => {
    const dirty = { body: BODY, frontmatter: { next_steps: [{ label: 'Call Jane Doe', href: '/contact/' }] } };
    expect(checkNextStepsRedacted(dirty, { action_type: 'new_supporting_blog' }).ok).toBe(false);
    expect(checkNextStepsRedacted(dirty).ok).toBe(false); // no brief at all defaults to scanning
  });

  // Codex r4 on #5216 ("Run next-step redaction for supporting blogs").
  test.each([
    ['a name', { label: 'Call Jane Doe', href: '/contact/' }],
    ['an email', { label: 'Get a quote', href: '/contact/?email=jane.doe%40example.com' }],
    ['a phone', { label: 'Text 941-555-0199', href: '/contact/' }],
    ['an address', { label: 'Get a quote', href: '/contact/?address=4867+Maple+Street' }],
  ])('a supporting-blog draft with %s in next_steps hard-fails the full gate', (_label, step) => {
    const result = gate.evaluate(
      { body: BODY, frontmatter: { next_steps: [step] } },
      { page_type: 'supporting-blog', action_type: 'new_supporting_blog' },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.hard_failures.map((f) => f.name)).toContain('next_steps_redacted');
  });

  test('the supporting-blog BODY is still not PII-scanned (owner decision)', () => {
    const result = gate.evaluate(
      { body: `${BODY}\n\nAsk Jane Doe at 4867 Maple Street.`, frontmatter: {} },
      { page_type: 'supporting-blog', action_type: 'new_supporting_blog' },
      {},
    );
    expect(result.checks.next_steps_redacted).toMatchObject({ ok: true });
    expect(result.checks.redaction_passed).toBeUndefined();
  });

  test('a refresh draft with dirty next_steps does not hard-fail the full gate on them', () => {
    const result = gate.evaluate(
      { body: BODY, frontmatter: { next_steps: [{ label: 'Call Jane Doe', href: '/contact/' }] } },
      { page_type: 'refresh', action_type: 'refresh_existing_page' },
      {},
    );
    expect(result.checks.next_steps_redacted).toMatchObject({ ok: true, reason: 'refresh_frontmatter_not_published' });
    expect(result.hard_failures.map((f) => f.name)).not.toContain('next_steps_redacted');
  });

  test('checkRedactionPassed no longer scans next_steps itself (one path)', () => {
    expect(checkRedactionPassed({ body: BODY, frontmatter: { next_steps: [{ label: 'Call Jane Doe', href: '/contact/' }] } })).toEqual({ ok: true });
  });

  test('the scan uses the guardrails\' own [label](href) synthesis', () => {
    const { nextStepsLinkMarkdown } = require('../services/content/content-guardrails');
    expect(nextStepsLinkMarkdown({ next_steps: [{ label: ' Go ', href: ' /contact/ ' }] })).toBe('[Go](/contact/)');
  });
});

// Codex r5 on #5216 ("Persist customer-question identity across
// publication"): page_type is not in the blog schema and no live post ever
// carries it, so the durable marker is the LIVE BODY — a refresh whose live
// body already opens on BottomLineBox keeps the answer-first contract,
// whatever its frontmatter says.
describe('refresh of a customer-question page keeps answer-first', () => {
  const refreshBrief = () => brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
  const noBoxBody = 'Intro prose first.\n\n<BottomLineBox verdict="v" recommendation="r" />';
  const liveWithBox = '<BottomLineBox verdict="Yes." recommendation="Call a pro." />\n\nOld swarmer prose.';
  const liveWithoutBox = 'Old prose with no leading verdict box at all.';

  test('a refresh whose LIVE body opens on BottomLineBox is held to answer-first, even when the draft moves/removes it', () => {
    expect(checkVerdictBoxFirst({ frontmatter: {}, body: noBoxBody }, refreshBrief(), { previousVersion: { body: liveWithBox } }))
      .toEqual({ ok: false, reason: 'verdict_box_not_first_block' });
  });
  test('a refresh whose live body has no leading box, on a non-diagnostic live post, is not held to it', () => {
    expect(checkVerdictBoxFirst({ frontmatter: {}, body: noBoxBody }, refreshBrief(), { previousVersion: { body: liveWithoutBox } }).ok).toBe(true);
    expect(checkVerdictBoxFirst({ frontmatter: {}, body: noBoxBody }, refreshBrief(), {}).ok).toBe(true);
  });
  test('a new post\'s draft page_type does not change its classification', () => {
    expect(checkVerdictBoxFirst({ frontmatter: { page_type: 'customer-question' }, body: noBoxBody }, brief()).ok).toBe(true);
  });
});

// Codex r4 on #5216 ("Evaluate the verdict text as the first answer").
describe('answer_in_first_paragraph reads the leading verdict box', () => {
  const { checkAnswerInFirstParagraph } = require('../services/content/content-quality-gate')._internals;
  const q = { target_keyword: 'Can cockroaches fly?' };
  test('"Can cockroaches fly?" with verdict="Yes, some species can." passes', () => {
    const body = '<BottomLineBox verdict="Yes, some species can." recommendation="Seal gaps around doors and vents." />\n\nMore prose.';
    expect(checkAnswerInFirstParagraph({ body }, q)).toEqual({ ok: true });
  });
  test('a leading box with no verdict fails', () => {
    expect(checkAnswerInFirstParagraph({ body: '<BottomLineBox recommendation="Seal gaps." />\n\nMore.' }, q))
      .toEqual({ ok: false, reason: 'verdict_box_has_no_verdict' });
  });
  test('without a leading box the first paragraph is judged by the same answer rule', () => {
    expect(checkAnswerInFirstParagraph({ body: 'Professional help is available.\n\nMore.' }, q))
      .toEqual({ ok: false, reason: 'first_paragraph_doesnt_address_question' });
    expect(checkAnswerInFirstParagraph({ body: 'Yes, some species can.\n\nMore.' }, q)).toEqual({ ok: true });
    expect(checkAnswerInFirstParagraph({ body: 'Some cockroaches can fly short distances.\n\nMore.' }, q)).toEqual({ ok: true });
  });

  // Codex r6 on #5216 ("Normalize question tokens before matching verdicts").
  test('a short WH question is judged on its own words, punctuation stripped', () => {
    const wh = { target_keyword: 'What do fire ants look like?' };
    const box = (v) => `<BottomLineBox verdict="${v}" recommendation="Keep kids and pets off the mound." />\n\nMore.`;
    expect(checkAnswerInFirstParagraph({ body: box('Fire ants are small, reddish-brown and build dome mounds.') }, wh)).toEqual({ ok: true });
    expect(checkAnswerInFirstParagraph({ body: box('Professional help is available.') }, wh))
      .toEqual({ ok: false, reason: 'verdict_does_not_answer_question' });
  });

  // Codex r5 on #5216 ("Require the verdict to answer the customer
  // question"): r4 accepted ANY nonempty short verdict once the box was
  // first — a generic verdict that never touches the question passed.
  test('"Can cockroaches fly?" with a generic verdict that never answers it fails', () => {
    const body = '<BottomLineBox verdict="Professional help is available." recommendation="Call us today." />\n\nMore prose.';
    expect(checkAnswerInFirstParagraph({ body }, q)).toEqual({ ok: false, reason: 'verdict_does_not_answer_question' });
  });

  test('"How do I get rid of ghost ants?" with a verdict naming ghost ants passes; a generic CTA verdict fails', () => {
    const ghostQ = { target_keyword: 'How do I get rid of ghost ants?' };
    const named = '<BottomLineBox verdict="Ghost ants trail along kitchen counters looking for sugar." recommendation="Wipe trails and bait the colony." />\n\nMore.';
    expect(checkAnswerInFirstParagraph({ body: named }, ghostQ)).toEqual({ ok: true });
    const generic = '<BottomLineBox verdict="Professional treatment gets the best results." recommendation="Call for a free estimate." />\n\nMore.';
    expect(checkAnswerInFirstParagraph({ body: generic }, ghostQ)).toEqual({ ok: false, reason: 'verdict_does_not_answer_question' });
  });
});

// ── Codex r7 on #5216 ────────────────────────────────────────────────
describe('Codex r7: catalog attribution lines vs the generic scans', () => {
  const { checkRedactionPassed } = require('../services/content/content-quality-gate')._internals;
  const guardrails = require('../services/content/content-guardrails');
  test.each(PHOTO_LIBRARY.map((p) => [p.catalog_slug, p]))('%s: its exact attribution line passes the syntax and PII scans', (_slug, photo) => {
    const body = `Fire ants sting.\n\n![${photo.alt}](${photo.src})\n\n${photoAttributionLine(photo)}\n\nMore prose here.`;
    expect(guardrails.unsupportedBodySyntax(body)).toEqual([]);
    expect(checkRedactionPassed({ body }).ok).toBe(true);
  });
  test('a non-catalog encoded destination is still unsupported syntax', () => {
    expect(guardrails.unsupportedBodySyntax('See [this](https://example.com/File:Ant_%28x%29.jpg).')).toContain('entity_or_encoded_destination');
  });
});

describe('Codex r7: verdict keywords match whole words', () => {
  const { checkAnswerInFirstParagraph } = require('../services/content/content-quality-gate')._internals;
  const wh = { target_keyword: 'What do fire ants look like?' };
  const box = (v) => `<BottomLineBox verdict="${v}" recommendation="Keep kids off the mound." />\n\nMore.`;
  test('"Plants grow nearby." does not answer a fire-ant question', () => {
    expect(checkAnswerInFirstParagraph({ body: box('Plants grow nearby.') }, wh)).toEqual({ ok: false, reason: 'verdict_does_not_answer_question' });
  });
  test('a singular/plural form still matches', () => {
    expect(checkAnswerInFirstParagraph({ body: box('A fire ant is small and reddish-brown.') }, wh)).toEqual({ ok: true });
    expect(checkAnswerInFirstParagraph({ body: box('A cockroach can glide short distances.') }, { target_keyword: 'Can cockroaches fly?' })).toEqual({ ok: true });
  });
});

describe('Codex r7: a decision post\'s leading box is not a question marker', () => {
  const refresh = brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
  const live = '<BottomLineBox verdict="Go with a plan." recommendation="Compare the two." />\n\nIntro.';
  const moved = { frontmatter: {}, body: 'New intro.\n\n<BottomLineBox verdict="Go with a plan." recommendation="Compare the two." />' };
  test('a decision refresh may move its box', () => {
    const ctx = { liveFrontmatter: { post_type: 'decision' }, previousVersion: { body: live } };
    expect(checkVerdictBoxFirst(moved, refresh, ctx)).toEqual({ ok: true, reason: 'not_identification_or_question' });
  });
  test('a non-decision page that opened on a box keeps it first', () => {
    const ctx = { liveFrontmatter: { post_type: 'location' }, previousVersion: { body: live } };
    expect(checkVerdictBoxFirst(moved, refresh, ctx)).toEqual({ ok: false, reason: 'verdict_box_not_first_block' });
  });
});

describe('Codex r7: a legacy .md target is read like the publisher reads it', () => {
  const refresh = brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
  const ctx = { liveFrontmatter: { post_type: 'diagnostic' }, previousVersion: { body: 'Old intro.' } };
  const body = '<BottomLineBox verdict="Yes, they sting." recommendation="Avoid the mound." />\n\n<div>\n![not an image here](/images/blog/other/x.webp)\n</div>\n\nMore.';
  test('Markdown inside a raw HTML block of a .md file is literal text, not an image', () => {
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body }, { ...refresh, target_file_path: 'src/content/blog/pest-control/x.md' }, ctx)).toEqual({ ok: true });
  });
  test('the same body on an .mdx target is judged as an image', () => {
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body }, { ...refresh, target_file_path: 'src/content/blog/pest-control/x.mdx' }, ctx).ok).toBe(false);
  });
});

// ── Codex r9 on #5216 ────────────────────────────────────────────────
describe('Codex r9: page_type "diagnostic" alone is an identification draft', () => {
  test('an unrelated committed image on a page_type-only diagnostic draft fails', () => {
    const r = checkPhotoSlotsLicensedOnly({ frontmatter: { page_type: 'diagnostic' }, body: 'Intro.\n\n![a picture](/images/blog/other/x.webp)' }, brief());
    expect(r).toEqual({ ok: false, reason: 'unlicensed_or_unknown_identification_photo:/images/blog/other/x.webp' });
  });
  test('the verdict box is required on it too', () => {
    expect(checkVerdictBoxFirst({ frontmatter: { page_type: 'diagnostic' }, body: 'Fire ants sting.' }, brief()).reason).toBe('verdict_box_not_first_block');
  });
});

describe('Codex r9: four-letter nouns survive beside a long qualifier', () => {
  const { checkAnswerInFirstParagraph } = require('../services/content/content-quality-gate')._internals;
  const q = { target_keyword: 'What do fire ants look like in Florida?' };
  const box = (v) => `<BottomLineBox verdict="${v}" recommendation="Keep kids off the mound." />\n\nMore.`;
  test('"Fire ants are small and reddish-brown" answers it', () => {
    expect(checkAnswerInFirstParagraph({ body: box('Fire ants are small and reddish-brown.') }, q)).toEqual({ ok: true });
  });
});

// ── Codex r8 on #5216 (follow-up PR) ─────────────────────────────────
describe('Codex r8: the run ledger marks a customer-question page on refresh', () => {
  const refresh = brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
  const live = '<BottomLineBox verdict="Yes, you should." recommendation="Compare both." />\n\nIntro.';
  const moved = { frontmatter: {}, body: 'New intro.\n\n<BottomLineBox verdict="Yes, you should." recommendation="Compare both." />' };
  const ctx = (extra) => ({ liveFrontmatter: { post_type: 'decision' }, previousVersion: { body: live }, ...extra });
  test('a decision-shaped customer question keeps its box first', () => {
    expect(checkVerdictBoxFirst(moved, refresh, ctx({ liveIsCustomerQuestion: true }))).toEqual({ ok: false, reason: 'verdict_box_not_first_block' });
  });
  test('a decision post the ledger does not mark may move its box', () => {
    expect(checkVerdictBoxFirst(moved, refresh, ctx({ liveIsCustomerQuestion: false }))).toEqual({ ok: true, reason: 'not_identification_or_question' });
  });
  test('an unreadable ledger holds a page that opens on the box (fail closed)', () => {
    expect(checkVerdictBoxFirst(moved, refresh, ctx({ liveQuestionLedgerUnavailable: true })).ok).toBe(false);
  });
  test('a ledger-marked page is held even when its live body no longer opens on the box', () => {
    const c = { liveFrontmatter: { post_type: 'location' }, previousVersion: { body: 'Intro.' }, liveIsCustomerQuestion: true };
    expect(checkVerdictBoxFirst(moved, refresh, c).ok).toBe(false);
  });
});

describe('Codex r8: no sales pitch inside the verdict box', () => {
  const run = (props) => checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body: `<BottomLineBox ${props} />\n\nMore.` }, brief());
  test.each([
    ['verdict="Cockroaches can fly. Get a free estimate now." recommendation="Seal gaps."'],
    ['verdict="Yes, they sting." recommendation="Call today."'],
    ['verdict="Yes, they sting." recommendation="Call (941) 297-5749 for help."'],
    ['verdict="Yes, they sting." recommendation="Call {{cityPhone}}."'],
  ])('%s is a pitch', (props) => {
    expect(run(props)).toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
  });
  test('advice to call a licensed pro is not a pitch', () => {
    expect(run('verdict="Yes, fire ants sting and it hurts." recommendation="Keep kids off the mound; call a licensed pro if the mound is near the house."')).toEqual({ ok: true });
  });
});

describe('Codex r8: each photo credit sits directly below its image', () => {
  const credited = `![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
  test('a credit directly below passes', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${credited}\n\nMore.`), slotsBrief())).toEqual({ ok: true });
  });
  test('a credit in a distant footer does not count', () => {
    const body = `Intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\nA paragraph between.\n\n${ATTR}`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
  });
  test('two copies of the photo need two credits', () => {
    const body = `Intro.\n\n${credited}\n\nMore.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\nEnd.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n${credited}\n\nMore.\n\n${credited}\n\nEnd.`), slotsBrief())).toEqual({ ok: true });
  });
});

// ── Codex r1 on #5272 ────────────────────────────────────────────────
describe('#5272 r1: compact phone numbers in the box, reference-style credits', () => {
  test.each([
    ['verdict="Yes, they sting." recommendation="Text 9412975749 for help."'],
    ['verdict="Yes, they sting." recommendation="Call +19412975749."'],
  ])('%s is a pitch', (props) => {
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body: `<BottomLineBox ${props} />\n\nMore.` }, brief()))
      .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
  });
  test('a reference definition between the image and its credit is skipped', () => {
    const body = `Intro.\n\n![${PHOTO.alt}][pest]\n\n[pest]: ${PHOTO_URL}\n\n${ATTR}\n\nMore.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: true });
  });
});

// Codex r2 on #5272 ("Start the credit check after the complete image span").
test('#5272 r2: a credit directly below an image whose alt wraps a line passes', () => {
  const wrapped = PHOTO.alt.replace(' ', '\n');
  const body = `Intro.\n\n![${wrapped}](${PHOTO_URL})\n\n${ATTR}\n\nMore.`;
  expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: true });
});

// ── Codex r3 on #5272 ────────────────────────────────────────────────
describe('#5272 r3: multi-line reference definitions, one credit per copy', () => {
  test('a multi-line reference definition between the image and its credit is skipped', () => {
    const body = `Intro.\n\n![${PHOTO.alt}][pest]\n\n[pest]:\n  ${PHOTO_URL}\n  "A title"\n\n${ATTR}\n\nMore.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: true });
  });
  test('two copies on one line cannot share one credit', () => {
    const body = `Intro.\n\n![${PHOTO.alt}](${PHOTO_URL}) ![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}\n\nMore.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
  });
});

// ── Codex r4 on #5272 ────────────────────────────────────────────────
describe('#5272 r4: expression props and visible components', () => {
  test('a pitch in a static-expression prop is still a pitch', () => {
    const body = '<BottomLineBox verdict={"Yes, they sting."} recommendation={"Call today."} />\n\nMore.';
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
      .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
  });
  test('an expression-prop verdict is read as the answer', () => {
    const { checkAnswerInFirstParagraph } = require('../services/content/content-quality-gate')._internals;
    const body = '<BottomLineBox verdict={"Yes, some species can."} recommendation={"Seal gaps."} />\n\nMore.';
    expect(checkAnswerInFirstParagraph({ body }, { target_keyword: 'Can cockroaches fly?' })).toEqual({ ok: true });
  });
  test('a visible component between the image and its credit breaks adjacency', () => {
    const body = `Intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n<InlineCTA ctaHref="/contact/" />\n\n${ATTR}\n\nMore.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: false, reason: `identification_photo_attribution_missing:${PHOTO_URL}` });
  });
});

// ── Codex r5 on #5272 ────────────────────────────────────────────────
describe('#5272 r5: decoded prop values, blockquote definitions', () => {
  test.each([
    ['recommendation={"Call\\x20today."}'],
    ['recommendation={"Call\\u0020today."}'],
    ['recommendation="Call&#32;today."'],
  ])('%s decodes to a pitch', (prop) => {
    const body = `<BottomLineBox verdict="Yes, they sting." ${prop} />\n\nMore.`;
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
      .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
  });
  test('a reference definition inside a blockquote between the image and its credit is skipped', () => {
    const body = `Intro.\n\n![${PHOTO.alt}][p]\n\n> [p]: ${PHOTO_URL}\n\n${ATTR}\n\nMore.`;
    expect(checkPhotoSlotsLicensedOnly(diag(body), slotsBrief())).toEqual({ ok: true });
  });
});

// Codex r6 on #5272 ("Decode all rendered whitespace entities").
test.each([
  ['recommendation="Call&nbsp;today."'],
  ['recommendation="Call&#160;today."'],
  ['recommendation={"Call\\u00a0today."}'],
])('#5272 r6: %s is a pitch', (prop) => {
  const body = `<BottomLineBox verdict="Yes, they sting." ${prop} />\n\nMore.`;
  expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
    .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
});

// Codex r7 on #5272: full HTML decoding and JS-parsed expression props.
test.each([
  ['recommendation="Call&Tab;today."'],
  ['recommendation="Call&NonBreakingSpace;today."'],
  ['recommendation={"Call today." /* note */}'],
  ['recommendation={"Call " + "today."}'],
])('#5272 r7: %s is a pitch', (prop) => {
  const body = `<BottomLineBox verdict="Yes, they sting." ${prop} />\n\nMore.`;
  expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
    .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
});

// Codex r8 on #5272 ("Fail closed on unevaluable verdict-box expressions").
test('#5272 r8: a verdict-box prop that is not a static string fails closed', () => {
  const body = '<BottomLineBox verdict="Yes, they sting." recommendation={true ? "Call today." : "Wait."} />\n\nMore.';
  expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
    .toEqual({ ok: false, reason: 'verdict_box_prop_not_static' });
});

// ── Codex r9 on #5272 ────────────────────────────────────────────────
describe('#5272 r9: escape-aware box tag, duplicate props', () => {
  test('an escaped quote inside an expression prop does not hide the box', () => {
    const body = '<BottomLineBox verdict={"Yes, ants sting."} recommendation={"Don\\"t wait; call today."} />\n\nMore.';
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
      .toEqual({ ok: false, reason: 'sales_pitch_inside_verdict_box' });
  });
  test('a repeated recommendation prop fails closed', () => {
    const body = '<BottomLineBox verdict="Yes, they sting." recommendation="Seal gaps." recommendation="Call today." />\n\nMore.';
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
      .toEqual({ ok: false, reason: 'verdict_box_prop_not_static' });
  });
});


// Later-queue from #5272 r10: eachJsxAttr skips spreads, so a spread that
// overrides a literal prop was read as the literal.
describe('verdict box with a JSX spread fails closed', () => {
  test.each([
    ['<BottomLineBox verdict="Yes, they sting." recommendation="Seal gaps." {...{recommendation: "Call today."}} />'],
    ['<BottomLineBox {...{verdict: "Yes, they sting."}} recommendation="Seal gaps." />'],
    ['<BottomLineBox verdict="Yes, they sting." recommendation="Seal gaps." { /* c */ ...props} />'],
  ])('%s', (tag) => {
    const body = `${tag}\n\nMore.`;
    expect(checkCtaAfterVerdictBox({ frontmatter: { post_type: 'diagnostic' }, body }, brief()))
      .toEqual({ ok: false, reason: 'verdict_box_prop_not_static' });
  });
  test('a spread box has no readable verdict for the answer-first check', () => {
    const { checkAnswerInFirstParagraph } = require('../services/content/content-quality-gate')._internals;
    const body = '<BottomLineBox verdict="Yes, fire ants sting." recommendation="Seal gaps." {...extra} />\n\nMore.';
    expect(checkAnswerInFirstParagraph({ body }, { customer_signal: { normalized_question: 'Do fire ants sting?' } }))
      .toEqual({ ok: false, reason: 'verdict_box_has_no_verdict' });
  });
});
