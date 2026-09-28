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

  test('the SAME citation DOES clear HARDCODED_PRICE when it rides requiredSourceUrls instead (contrast case)', () => {
    const body = `Aptive's early-cancellation fee is $199 as of June 2026 per [source](${COMMONS_URL}).`;
    const result = guardrails.evaluate(
      { body },
      { competitorPriceCitations: true, requiredSourceUrls: [COMMONS_URL] },
    );
    expect(result.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(false);
  });
});
