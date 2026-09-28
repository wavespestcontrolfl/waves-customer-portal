/**
 * photoAllowedUrls (Codex P1, 2026-09-28): licensed identification-photo /
 * source-page / license URLs are an outbound-link allowance ONLY — they
 * must exempt a link from DISALLOWED_EXTERNAL_LINK but can NEVER satisfy
 * a factual/price citation check (priceParagraphIsSourced /
 * findHardcodedPrice), which reads ONLY requiredSourceUrls. Before this
 * fix, photo URLs rode requiredSourceUrls itself, so a competitor-intercept
 * brief that also matched a photo slot could cite the Commons photo/license
 * page as sourcing evidence for a competitor's dollar figure.
 */
jest.mock('../models/db', () => jest.fn());

const guardrails = require('../services/content/content-guardrails');

const COMMONS_URL = 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg';
const LICENSE_URL = 'https://creativecommons.org/licenses/by/2.0';
const PHOTO_URL = 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg';

describe('externalLinkFinding — photoAllowedUrls', () => {
  test('a photo/source/license URL passed ONLY via photoAllowedUrls is exempt from DISALLOWED_EXTERNAL_LINK', () => {
    const body = `Photo: [credit](${COMMONS_URL}) ([CC BY 2.0](${LICENSE_URL})). Image: ${PHOTO_URL}`;
    const r = guardrails._internals.externalLinkFinding(body, { requiredSourceUrls: [], photoAllowedUrls: [COMMONS_URL, LICENSE_URL, PHOTO_URL] });
    expect(r).toBeNull();
  });

  test('without photoAllowedUrls, the same URLs are NOT allowed (proves the allowance is doing real work)', () => {
    const body = `Photo: [credit](${COMMONS_URL})`;
    const r = guardrails._internals.externalLinkFinding(body, { requiredSourceUrls: [] });
    expect(r?.code).toBe('DISALLOWED_EXTERNAL_LINK');
  });
});

// Pre-push fallback review on #5216 (Codex over usage limit, Claude
// Sonnet audit): libraryPhotoAttributionUrls used to be a second,
// inline-only regex, out of step with the quality gate's own bodyImageRefs
// -based parser — a licensed photo embedded via reference-style or
// shortcut Markdown (which the gate approves) had its attribution links
// missed here, so a fully compliant draft hard-failed at publish as
// DISALLOWED_EXTERNAL_LINK. Now the SAME parser as the gate.
describe('libraryPhotoAttributionUrls — same parser as the quality gate (reference/shortcut forms)', () => {
  const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');
  const photo = PHOTO_LIBRARY[0];

  test('a licensed photo embedded as a full reference (`![alt][ref]`) is allowed, not DISALLOWED_EXTERNAL_LINK', () => {
    const body = [
      `![${photo.alt}][pic]`,
      '',
      photoAttributionLine(photo),
      '',
      `[pic]: ${photo.src}`,
    ].join('\n');
    const result = guardrails.evaluate({ body }, {});
    expect(result.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });

  test('a licensed photo embedded as a shortcut reference (`![alt]`) is allowed too', () => {
    const body = [
      `![${photo.alt}]`,
      '',
      photoAttributionLine(photo),
      '',
      `[${photo.alt}]: ${photo.src}`,
    ].join('\n');
    const result = guardrails.evaluate({ body }, {});
    expect(result.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });
});

describe('priceParagraphIsSourced / findHardcodedPrice — photoAllowedUrls must NEVER satisfy sourcing', () => {
  test('a competitor price citing ONLY a library photo\'s source page still HARD-fails HARDCODED_PRICE', () => {
    // The body shows a library photo, so its source page IS allowed as an
    // outbound link — but that allowance never reaches price sourcing.
    const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');
    const photo = PHOTO_LIBRARY[0];
    const body = [
      `![${photo.alt}](${photo.src})`,
      '',
      photoAttributionLine(photo),
      '',
      `Aptive's early-cancellation fee is $199 as of June 2026 per [source](${photo.source_page}).`,
    ].join('\n');
    const result = guardrails.evaluate({ body }, { competitorPriceCitations: true, requiredSourceUrls: [] });
    expect(result.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(true);
    // ...but the link itself is still permitted (not a DOUBLE penalty).
    expect(result.findings.some((f) => f.code === 'DISALLOWED_EXTERNAL_LINK')).toBe(false);
  });

  // Contrast in the current competitor-price form (#5191: plain prose, the
  // company's own page under "Evidence sources"): the company page clears
  // HARDCODED_PRICE, a library photo's source page never does.
  test('a competitor price sourced from the company page clears; the photo source page does not (contrast case)', () => {
    const { PHOTO_LIBRARY } = require('../services/content/licensed-photo-library');
    const photo = PHOTO_LIBRARY[0];
    const body = "Orkin's early-cancellation fee is $199 as of June 2026.";
    const sourced = guardrails.evaluate({ body, notes_for_reviewer: 'Evidence sources: https://www.orkin.com/pricing' }, { competitorPriceCitations: true });
    expect(sourced.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(false);
    const photoSourced = guardrails.evaluate(
      { body, notes_for_reviewer: `Evidence sources: ${photo.source_page}` },
      { competitorPriceCitations: true, photoAllowedUrls: [photo.source_page, photo.license_url] },
    );
    expect(photoSourced.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(true);
  });
});
