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
const { deriveSyncGuardrailOptions } = require('../services/content/guardrail-options');

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
  test('a competitor price citing ONLY a photoAllowedUrls URL still HARD-fails HARDCODED_PRICE', () => {
    const body = `Aptive's early-cancellation fee is $199 as of June 2026 per [source](${COMMONS_URL}).`;
    // priceFinding/findHardcodedPrice do not even accept a photoAllowedUrls
    // parameter — this proves it structurally, not just behaviorally: the
    // exact same options object that satisfies externalLinkFinding (via
    // photoAllowedUrls) leaves the citation UNRECOGNIZED for price sourcing
    // (requiredSourceUrls stays empty).
    const result = guardrails.evaluate(
      { body },
      { competitorPriceCitations: true, requiredSourceUrls: [], photoAllowedUrls: [COMMONS_URL] },
    );
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

describe('guardrail-options.deriveSyncGuardrailOptions — photo URLs ride photoAllowedUrls, not requiredSourceUrls', () => {
  test('photo/source/license URLs land in photoAllowedUrls', () => {
    const brief = {
      action_type: 'new_supporting_blog',
      page_type: 'supporting-blog',
      voice_constraints: {
        photo_slots: [
          {
            slot: 'pest',
            photo: { url: PHOTO_URL, source_page: COMMONS_URL, license_url: LICENSE_URL, alt: 'x', credit: 'Judy Gallagher', license: 'CC BY 2.0' },
            flagged_for_human: false,
          },
        ],
      },
    };
    const opts = deriveSyncGuardrailOptions({ id: 'opp-1', bucket: 'customer_need' }, brief);
    expect(opts.photoAllowedUrls).toEqual(expect.arrayContaining([PHOTO_URL, COMMONS_URL, LICENSE_URL]));
  });

  test('photo/source/license URLs are NOT duplicated into requiredSourceUrls', () => {
    const brief = {
      action_type: 'new_supporting_blog',
      page_type: 'supporting-blog',
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: { url: PHOTO_URL, source_page: COMMONS_URL, license_url: LICENSE_URL, alt: 'x' }, flagged_for_human: false },
        ],
      },
    };
    const opts = deriveSyncGuardrailOptions({ id: 'opp-1', bucket: 'customer_need' }, brief);
    expect(opts.requiredSourceUrls).not.toEqual(expect.arrayContaining([PHOTO_URL]));
    expect(opts.requiredSourceUrls).not.toEqual(expect.arrayContaining([COMMONS_URL]));
    expect(opts.requiredSourceUrls).not.toEqual(expect.arrayContaining([LICENSE_URL]));
  });
});
