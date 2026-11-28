'use strict';

const {
  hasConfirmedBookingOnCall,
  shouldSuppressDraftForAgreedPrice,
} = require('../utils/call-agreed-price');
const {
  askedServiceLinesRequired,
  askedRequiredLinesForPromise,
  estimateCoversAllAskedLines,
  estimatesCoverAskedLines,
  findCoveringEstimate,
  missingAskedServiceLines,
} = require('../services/call-estimate-service-match');
const { _private: { applyVerbalPriceReviewNotice } } = require('../services/estimator-engine');

describe('PR C1b: Unbooked written-quote-promised exception for verbal price quotes', () => {
  const agreed = { amount: 250, unit: 'one_time' };

  test('ALWAYS suppresses drafting when a visit is confirmed/booked on the call (2026-09-24 ruling preserved)', () => {
    expect(hasConfirmedBookingOnCall({ appointment_confirmed: true }, null)).toBe(true);
    expect(hasConfirmedBookingOnCall({}, { scheduling: { status: 'confirmed' } })).toBe(true);
    expect(hasConfirmedBookingOnCall({}, { scheduling: { status: 'proposed', agent_committed_booking: true } })).toBe(true);

    expect(shouldSuppressDraftForAgreedPrice({
      agreedPrice: agreed,
      quotePromised: true,
      extracted: { appointment_confirmed: true },
      v2Extraction: { scheduling: { status: 'confirmed' } },
    })).toBe(true);

    expect(shouldSuppressDraftForAgreedPrice({
      agreedPrice: agreed,
      quotePromised: true,
      extracted: { appointment_confirmed: false },
      v2Extraction: { scheduling: { status: 'proposed', agent_committed_booking: true } },
    })).toBe(true);
  });

  test('ALWAYS suppresses drafting when no written quote was promised', () => {
    expect(shouldSuppressDraftForAgreedPrice({
      agreedPrice: agreed,
      quotePromised: false,
      extracted: { appointment_confirmed: false },
      v2Extraction: { scheduling: { status: 'none' } },
    })).toBe(true);
  });

  test('allows drafting for staff review ONLY when NO visit was booked AND staff promised a written quote', () => {
    expect(shouldSuppressDraftForAgreedPrice({
      agreedPrice: agreed,
      quotePromised: true,
      extracted: { appointment_confirmed: false },
      v2Extraction: { scheduling: { status: 'none', agent_committed_booking: false } },
    })).toBe(false);

    expect(shouldSuppressDraftForAgreedPrice({ agreedPrice: null, quotePromised: false })).toBe(false);
  });

  test('applyVerbalPriceReviewNotice elevates green drafts to yellow with verbal price banner and preserves red', () => {
    const context = {
      call: {
        v2_extraction_status: 'valid',
        ai_extraction_enriched: {
          service_request: { price: { amount_usd: 250, unit: 'one_time', accepted: true } },
        },
      },
    };
    const elevated = applyVerbalPriceReviewNotice({ lane: 'green', reasons: [], causes: [] }, context);
    expect(elevated.lane).toBe('yellow');
    expect(elevated.reasons).toEqual([
      'verbal price discussed on call ($250.00 one-time) — verify written quote matches',
    ]);

    const red = applyVerbalPriceReviewNotice({ lane: 'red', reasons: ['missing address'], causes: [] }, context);
    expect(red.lane).toBe('red');
    expect(red.reasons).toEqual(['missing address']);

    const noV2 = applyVerbalPriceReviewNotice({ lane: 'green', reasons: [] }, {
      call: { v2_extraction_status: 'schema_failed', ai_extraction_enriched: context.call.ai_extraction_enriched },
    });
    expect(noV2.lane).toBe('green');
    expect(noV2.reasons).toEqual([]);
  });
});

describe('PR C1b: Multi-service and exact estimate coverage matching', () => {
  const v2 = (primary, extra = {}) => ({ service_request: { primary_service_category: primary, ...extra } });

  test('askedServiceLinesRequired captures primary + secondary categories + multi-line bundle names', () => {
    expect(askedServiceLinesRequired(v2('pest_general', { secondary_categories: ['lawn_care'] }))).toEqual(['pest', 'lawn']);
    expect(askedServiceLinesRequired(v2('bundled_waveguard', { specific_service_name: 'Pest Control + Lawn Care' })).sort()).toEqual(['lawn', 'pest']);
    expect(askedServiceLinesRequired(v2('tree_shrub'))).toEqual(['tree_shrub']);
    expect(askedServiceLinesRequired(v2('flea_tick'))).toEqual(['pest']);
    expect(askedServiceLinesRequired(v2('wdo_inspection'))).toEqual(['termite']);
  });

  test('Pest-only estimate does NOT cover a Pest + Lawn ask, while bundle or two separate estimates DO', () => {
    const required = ['pest', 'lawn'];
    const pestOnly = { id: 'e1', service_interest: 'Pest Control' };
    const lawnOnly = { id: 'e2', service_interest: 'Lawn Care' };
    const bundle = { id: 'e3', service_interest: 'Pest Control + Lawn Care' };
    const unclassifiable = { id: 'e4', service_interest: 'Custom Proposal' };

    expect(estimateCoversAllAskedLines(required, ['pest'])).toBe(false);
    expect(estimateCoversAllAskedLines(required, ['pest', 'lawn'])).toBe(true);

    expect(estimatesCoverAskedLines(required, [pestOnly])).toBe(false);
    expect(missingAskedServiceLines(required, [pestOnly])).toEqual(['lawn']);
    expect(findCoveringEstimate(required, [pestOnly])).toBeNull();

    // Bundle covers both in one estimate
    expect(estimatesCoverAskedLines(required, [bundle])).toBe(true);
    expect(missingAskedServiceLines(required, [bundle])).toEqual([]);
    expect(findCoveringEstimate(required, [bundle])).toBe(bundle);

    // Two separate estimates collectively cover both; closing witness is the second (lawn) estimate
    expect(estimatesCoverAskedLines(required, [pestOnly, lawnOnly])).toBe(true);
    expect(missingAskedServiceLines(required, [pestOnly, lawnOnly])).toEqual([]);
    expect(findCoveringEstimate(required, [pestOnly, lawnOnly])).toBe(lawnOnly);

    // Fail-safe: unclassifiable / custom proposal never falsely blocks closure
    expect(estimatesCoverAskedLines(required, [unclassifiable])).toBe(true);
    expect(findCoveringEstimate(required, [unclassifiable])).toBe(unclassifiable);
  });

  test('askedRequiredLinesForPromise respects filing generation and human edit fences', () => {
    const ext = JSON.stringify(v2('pest_general', { secondary_categories: ['lawn_care'] }));
    const call = { v2_extraction_status: 'valid', processing_generation: 4, ai_extraction_enriched: ext };
    expect(askedRequiredLinesForPromise({ processing_generation: 4, source: 'ai', human_state: null }, call)).toEqual(['pest', 'lawn']);
    expect(askedRequiredLinesForPromise({ processing_generation: 3, source: 'ai', human_state: null }, call)).toEqual([]);
    expect(askedRequiredLinesForPromise({ processing_generation: 4, human_state: 'edited' }, call)).toEqual([]);
  });
});
