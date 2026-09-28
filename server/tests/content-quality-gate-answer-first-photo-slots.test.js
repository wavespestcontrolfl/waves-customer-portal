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

  test('passes a library photo with its catalog alt and exact attribution line — no brief slots needed', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`Intro.\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}\n\nMore.`), brief())).toEqual({ ok: true });
  });

  test('passes every library photo the same way', () => {
    for (const photo of PHOTO_LIBRARY) {
      const r = checkPhotoSlotsLicensedOnly(diag(`![${photo.alt}](${photo.src})\n\n${photoAttributionLine(photo)}`), brief());
      expect(r).toEqual({ ok: true });
    }
  });

  test('the same lookup approves the photo on a refresh and on a remediation revalidation (Codex r3)', () => {
    const body = `<BottomLineBox verdict="v" recommendation="r" />\n\n![${PHOTO.alt}](${PHOTO_URL})\n\n${ATTR}`;
    const refresh = brief({ action_type: 'refresh_existing_page', page_type: 'refresh' });
    expect(checkPhotoSlotsLicensedOnly({ frontmatter: {}, body }, refresh, { liveFrontmatter: { post_type: 'diagnostic' }, previousVersion: { body: 'old' } })).toEqual({ ok: true });
    // Remediation re-runs the gate on the committed Markdown with the stored brief.
    expect(checkPhotoSlotsLicensedOnly(diag(body), brief({ voice_constraints: { photo_slots: [] } }))).toEqual({ ok: true });
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

  test('reference-style images: unlicensed fails as unlicensed, a library photo as an unsupported form', () => {
    expect(checkPhotoSlotsLicensedOnly(diag('![fire ant][pic]\n\n[pic]: https://ai-art.example.com/x.png'), brief()).reason)
      .toMatch(/^unlicensed_or_unknown_identification_photo:/);
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}][pic]\n\n${ATTR}\n\n[pic]: ${PHOTO_URL}`), brief()).reason)
      .toBe(`identification_photo_unsupported_form:reference:${PHOTO_URL}`);
    expect(checkPhotoSlotsLicensedOnly(diag(`![${PHOTO.alt}][]\n\n${ATTR}\n\n[${PHOTO.alt}]: ${PHOTO_URL}`), brief()).reason)
      .toBe(`identification_photo_unsupported_form:reference:${PHOTO_URL}`);
  });

  test('incidental whitespace around the alt does not false-fail', () => {
    expect(checkPhotoSlotsLicensedOnly(diag(`![  ${PHOTO.alt}  ](${PHOTO_URL})\n\n${ATTR}`), brief()).ok).toBe(true);
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
describe('checkRedactionPassed — next_steps labels and hrefs', () => {
  const { checkRedactionPassed } = require('../services/content/content-quality-gate')._internals;
  const BODY = [
    '## What Fire Ants Look Like',
    '',
    'Red imported fire ants are small, reddish-brown ants that build loose mounds of sandy soil in sunny lawns. When the mound is disturbed, workers pour out and sting repeatedly.',
    '',
    '## When to Call',
    '',
    'If you see mounds near play areas or along walkways, treat them before the colony spreads. Our team handles fire ants across Sarasota and Manatee counties.',
  ].join('\n');
  const run = (step) => checkRedactionPassed({ body: BODY, frontmatter: { next_steps: [step] } });

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
    expect(checkRedactionPassed({ body: BODY, frontmatter: { next_steps: steps } })).toEqual({ ok: true });
  });

  test('the scan uses the guardrails\' own [label](href) synthesis', () => {
    const { nextStepsLinkMarkdown } = require('../services/content/content-guardrails');
    expect(nextStepsLinkMarkdown({ next_steps: [{ label: ' Go ', href: ' /contact/ ' }] })).toBe('[Go](/contact/)');
  });
});
