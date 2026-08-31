'use strict';

// Cancellation resolution engine (PR E) — the deterministic layer: taxonomy
// invariants, template slot validation (fail-closed, never prose), and the
// resolver's selection rules (hard stops, fix-over-money, money eligibility,
// 12-month same-card suppression, moving verification).

// retention-offer (imported by resolve) requires models/db for its ledger
// writes; the pure layer under test never touches it.
jest.mock('../models/db', () => jest.fn());

const { REASON_CODES, REASON_CODE_VALUES, REASON_CODE_VERSION, reasonCodeMeta } = require('../services/cancellation-resolution/reason-codes');
const { TEMPLATES, getTemplate, renderTemplate, RETENTION_OFFER } = require('../services/cancellation-resolution/templates');
const { resolveCancellation, ownerTextAudience } = require('../services/cancellation-resolution/resolve');

// Baseline facts: a long-tenured, current, two-family account that clears
// every offer gate. Tests override the one fact they exercise.
function baseFacts(overrides = {}) {
  return {
    customerId: 'cust-1',
    tenureDays: 800,
    completedVisits: 10,
    completedPaidVisits: 10,
    visits12mo: 6,
    callbacks12mo: 1,
    callbacksByLane: { pest: 0, lawn: 0 },
    reschedules12mo: 0,
    savings12mo: 184.5,
    accountCurrent: true,
    openComplaint: false,
    openCallbackLanes: [],
    lastFinding: null,
    firstFinding: null,
    lastComplaint: null,
    priorRetentionOfferAt: null,
    manualPriceOverrideAt: null,
    cardsShown12mo: [],
    tier: 'Gold',
    monthlyRate: 140,
    billingMode: 'monthly_membership',
    prepay: false,
    autopay: true,
    termiteRental: false,
    multiProperty: false,
    hasPreferredWindow: false,
    families: ['pest_control', 'lawn_care'],
    ...overrides,
  };
}

describe('reason taxonomy v2', () => {
  test('19 codes, version 2, four code-level hard stops with review types', () => {
    expect(REASON_CODE_VERSION).toBe(2);
    expect(REASON_CODE_VALUES).toHaveLength(19);
    const hard = REASON_CODES.filter((r) => r.hardStop).map((r) => r.code).sort();
    expect(hard).toEqual(['billing_issue', 'damage_or_adverse_effect', 'personal_circumstances', 'unexpected_recurring']);
    expect(reasonCodeMeta('billing_issue').reviewType).toBe('billing');
    expect(reasonCodeMeta('unexpected_recurring').reviewType).toBe('disclosure');
    expect(reasonCodeMeta('damage_or_adverse_effect').reviewType).toBe('incident');
    expect(reasonCodeMeta('personal_circumstances').reviewType).toBe('none');
  });

  test('migration CHECK list and code module stay in lockstep', () => {
    // The migration hardcodes its own copy (schema is a contract); a drifted
    // taxonomy would let the service write codes the CHECK rejects.
    const migration = require('fs').readFileSync(
      require('path').join(__dirname, '../models/migrations/20260830000040_cancellation_cases_and_retention_offers.js'),
      'utf8'
    );
    for (const code of REASON_CODE_VALUES) expect(migration).toContain(`'${code}'`);
  });

  test('every template belongs to a known reason and no copy breaks the language rules', () => {
    for (const t of TEMPLATES) {
      expect(REASON_CODE_VALUES).toContain(t.reason);
      const copy = `${t.headline} ${t.body}`;
      expect(copy).not.toMatch(/Adam/); // "our owner", never by name
      expect(copy).not.toMatch(/EPA-approved/i);
      expect(copy).not.toMatch(/\bsafe\b/i); // never "safe" for treatments
      expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emojis
    }
  });

  test('ruled offer values: 15% x 2 charges, $75 cap', () => {
    expect(RETENTION_OFFER).toEqual({ percentOff: 15, charges: 2, capAmount: 75 });
    expect(getTemplate('price_offer').body).toContain('15% off your next two charges');
  });
});

describe('template rendering (fail closed)', () => {
  test('valid slots render with no leftover tokens', () => {
    const out = renderTemplate(getTemplate('price_receipt'), { visits: 13, callbacks: 1, savings: 184 });
    expect(out.body).toContain('13 visits');
    expect(out.body).toContain('$184');
    expect(out.body).not.toMatch(/\{\w+\}/);
  });

  test('a missing or invalid slot drops the card entirely', () => {
    expect(renderTemplate(getTemplate('price_receipt'), { visits: 0, callbacks: 1, savings: 184 })).toBeNull();
    expect(renderTemplate(getTemplate('price_receipt'), { callbacks: 1, savings: 184 })).toBeNull();
    expect(renderTemplate(getTemplate('results_pest_fix_finding'), { finding: '' })).toBeNull();
    expect(renderTemplate(getTemplate('results_pest_fix_finding'), { finding: 'x'.repeat(200) })).toBeNull();
  });
});

describe('resolver — hard stops', () => {
  test('code-level hard stops never produce a card', () => {
    for (const code of ['billing_issue', 'unexpected_recurring', 'damage_or_adverse_effect', 'personal_circumstances']) {
      const out = resolveCancellation({ facts: baseFacts(), reasonCode: code });
      expect(out.kind).toBe('hard_stop');
      expect(out.reviewType).toBe(reasonCodeMeta(code).reviewType);
    }
  });

  test('situational hard stops: adverse event, safety complaint, verified out-of-area move', () => {
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'health_or_chemicals', context: { adverseEvent: true } }))
      .toMatchObject({ kind: 'hard_stop', reviewType: 'incident' });
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'service_experience', context: { safetyComplaint: true } }))
      .toMatchObject({ kind: 'hard_stop', reviewType: 'incident' });
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'moving_or_property_change', context: { newAddressInServiceArea: false } }))
      .toMatchObject({ kind: 'hard_stop', reviewType: 'none' });
  });

  test('skipped reason → clean cancel, nothing shown', () => {
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: null }).kind).toBe('none');
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'not_a_code' }).kind).toBe('none');
  });
});

describe('resolver — money rules', () => {
  test('eligible price cancel gets the receipt+offer card with the family action', () => {
    const out = resolveCancellation({ facts: baseFacts(), reasonCode: 'price', families: ['lawn_care'] });
    expect(out.kind).toBe('card');
    expect(out.card.templateId).toBe('price_receipt_offer');
    expect(out.card.action).toMatchObject({ type: 'retention_offer', percentOff: 15, charges: 2, capAmount: 75, familyKey: 'lawn_care' });
    expect(out.card.body).toContain('Lawn Care');
  });

  test('every eligibility blocker suppresses the offer (falls to the receipt)', () => {
    const blockers = [
      { tenureDays: 100 },
      { completedPaidVisits: 2, completedVisits: 2 },
      { accountCurrent: false },
      { openComplaint: true },
      { openCallbackLanes: ['pest'] },
      { prepay: true, billingMode: 'annual_prepay' },
      { priorRetentionOfferAt: new Date(Date.now() - 90 * 86400000).toISOString() },
    ];
    for (const override of blockers) {
      const out = resolveCancellation({ facts: baseFacts(override), reasonCode: 'price' });
      expect(out.kind).toBe('card');
      expect(out.card.templateId).toBe('price_receipt');
      expect(out.card.action.type).toBe('none');
    }
  });

  test('an 18-months-past offer no longer blocks', () => {
    const out = resolveCancellation({
      facts: baseFacts({ priorRetentionOfferAt: new Date(Date.now() - 600 * 86400000).toISOString() }),
      reasonCode: 'price',
    });
    expect(out.card.templateId).toBe('price_receipt_offer');
  });

  test('a requested family the account does not own cannot mint an offer for it', () => {
    const out = resolveCancellation({ facts: baseFacts({ families: ['termite_bait'] }), reasonCode: 'price', families: ['pest_control'] });
    // pest_control is not on the account: scope falls back to what IS owned.
    expect(out.kind === 'none' || out.card.action.type === 'none').toBe(true);
  });

  test('termite bait alone never gets money', () => {
    const out = resolveCancellation({ facts: baseFacts({ families: ['termite_bait'] }), reasonCode: 'price', families: ['termite_bait'] });
    expect(out.kind === 'none' || out.card.action.type === 'none').toBe(true);
  });

  test('diy is boxed into the same offer; ineligible diy gets the non-repellent card', () => {
    const eligible = resolveCancellation({ facts: baseFacts(), reasonCode: 'diy' });
    expect(eligible.card.templateId).toBe('diy_offer');
    const ineligible = resolveCancellation({ facts: baseFacts({ tenureDays: 30 }), reasonCode: 'diy' });
    expect(ineligible.card.templateId).toBe('diy_nonrepellent');
    expect(ineligible.card.body).not.toContain('%');
  });

  test('fix outranks money: results reasons never resolve to a retention_offer action', () => {
    for (const code of ['results_pest', 'results_lawn', 'service_experience', 'away', 'scheduling_access_communication']) {
      const out = resolveCancellation({ facts: baseFacts(), reasonCode: code });
      if (out.kind === 'card') expect(out.card.action.type).not.toBe('retention_offer');
    }
  });
});

describe('resolver — data-backed selection', () => {
  test('results_pest: 2+ callbacks → program change; finding → quoted finding; else generic fix', () => {
    expect(resolveCancellation({ facts: baseFacts({ callbacks12mo: 3, callbacksByLane: { pest: 3, lawn: 0 } }), reasonCode: 'results_pest' }).card.templateId)
      .toBe('results_pest_program_change');
    // Lawn callbacks must never trigger the pest program-change promise.
    expect(resolveCancellation({ facts: baseFacts({ callbacks12mo: 3, callbacksByLane: { pest: 0, lawn: 3 } }), reasonCode: 'results_pest' }).card.templateId)
      .toBe('results_pest_fix');
    const withFinding = resolveCancellation({
      facts: baseFacts({ lastFinding: { text: 'Ant trailing at the kitchen slab', lane: 'pest' } }),
      reasonCode: 'results_pest',
    });
    expect(withFinding.card.templateId).toBe('results_pest_fix_finding');
    expect(withFinding.card.body).toContain('Ant trailing at the kitchen slab');
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'results_pest' }).card.templateId).toBe('results_pest_fix');
  });

  test('an open callback in the lane suppresses re-service cards', () => {
    const out = resolveCancellation({ facts: baseFacts({ openCallbackLanes: ['pest'] }), reasonCode: 'results_pest' });
    expect(out.kind).toBe('none');
  });

  test('same card never twice in 12 months — next candidate or nothing', () => {
    const facts = baseFacts({ cardsShown12mo: ['price_receipt_offer'] });
    const out = resolveCancellation({ facts, reasonCode: 'price' });
    expect(out.card.templateId).toBe('price_offer');
    const exhausted = resolveCancellation({ facts: baseFacts({ cardsShown12mo: ['price_receipt_offer', 'price_offer'] }), reasonCode: 'price' });
    expect(exhausted.kind).toBe('none');
  });

  test('away picks by family mix', () => {
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'away' }).card.templateId).toBe('away_pairing');
    expect(resolveCancellation({ facts: baseFacts({ families: ['pest_control'] }), reasonCode: 'away' }).card.templateId).toBe('away_mode_pest');
    expect(resolveCancellation({ facts: baseFacts({ families: ['mosquito'] }), reasonCode: 'away' }).card.templateId).toBe('away_hold');
    expect(resolveCancellation({ facts: baseFacts({ families: ['termite_bait'] }), reasonCode: 'away' }).kind).toBe('none');
  });

  test('moving: card only on a VERIFIED in-area address', () => {
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'moving_or_property_change', context: { newAddressInServiceArea: true } }).card.templateId)
      .toBe('moving_transfer');
    expect(resolveCancellation({ facts: baseFacts(), reasonCode: 'moving_or_property_change', context: {} }).kind).toBe('none');
  });

  test('owner-text audience is the ruled default list', () => {
    expect(ownerTextAudience(baseFacts())).toBe(false);
    expect(ownerTextAudience(baseFacts({ prepay: true }))).toBe(true);
    expect(ownerTextAudience(baseFacts({ termiteRental: true }))).toBe(true);
    expect(ownerTextAudience(baseFacts({ multiProperty: true }))).toBe(true);
    expect(ownerTextAudience(baseFacts(), { hasCompetitorQuote: true })).toBe(true);
    expect(ownerTextAudience(baseFacts({ tenureDays: 400 }), { reasonCode: 'financial_hardship' })).toBe(true);
    expect(ownerTextAudience(baseFacts({ tenureDays: 100 }), { reasonCode: 'financial_hardship' })).toBe(false);
  });

  test('hardship: no hold anywhere; owner text only for the audience, else reduce', () => {
    const short = resolveCancellation({ facts: baseFacts({ tenureDays: 100 }), reasonCode: 'financial_hardship' });
    expect(short.card.templateId).toBe('hardship_reduce');
    const long = resolveCancellation({ facts: baseFacts({ tenureDays: 800 }), reasonCode: 'financial_hardship' });
    expect(long.card.templateId).toBe('hardship_owner_text');
    for (const out of [short, long]) expect(out.card.action.type).not.toBe('hold');
  });

  test('service_experience quotes the customer\'s own message when one is on file', () => {
    const out = resolveCancellation({
      facts: baseFacts({ lastComplaint: { date: '2026-08-12', quote: 'You missed the gate again' } }),
      reasonCode: 'service_experience',
    });
    expect(out.card.templateId).toBe('service_experience_known');
    expect(out.card.body).toContain('You missed the gate again');
  });

  test('competitor without quote and short history: no owner text, informational only', () => {
    const out = resolveCancellation({ facts: baseFacts({ completedVisits: 10 }), reasonCode: 'competitor' });
    expect(out.card.templateId).toBe('competitor_history');
    expect(out.card.action.type).toBe('none');
    const withQuote = resolveCancellation({ facts: baseFacts(), reasonCode: 'competitor', context: { hasCompetitorQuote: true } });
    expect(withQuote.card.templateId).toBe('competitor_quote');
    expect(withQuote.card.action.type).toBe('owner_text');
  });
});
