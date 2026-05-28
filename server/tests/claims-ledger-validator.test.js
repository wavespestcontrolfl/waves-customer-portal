const v = require('../services/content/claims-ledger-validator');

const FACTS = {
  city_sarasota_pest_ghost_ants_01: { id: 'city_sarasota_pest_ghost_ants_01', evidence_strength: 'directional', value: 'ghost ants common' },
  city_sarasota_neighborhood_laurel_park_01: { id: 'city_sarasota_neighborhood_laurel_park_01', evidence_strength: 'verified', value: 'Laurel Park' },
};

const BODY = 'Ghost ants are common during warmer months in Sarasota. Older homes in Laurel Park often need termite monitoring.';

describe('claims-ledger-validator (pure core)', () => {
  test('missing ledger → CLAIMS_LEDGER_MISSING (P2 default, non-blocking)', () => {
    const r = v.validateLedger({ claimsLedger: [], body: BODY, factsById: FACTS });
    expect(r.findings.some((f) => f.code === 'CLAIMS_LEDGER_MISSING')).toBe(true);
    expect(r.pass).toBe(true); // P2 by default
  });

  test('missing ledger escalates to P0 when configured → blocks', () => {
    const r = v.validateLedger({ claimsLedger: [], body: BODY, factsById: FACTS, options: { missingLedgerSeverity: 'P0' } });
    expect(r.pass).toBe(false);
  });

  test('claim citing an unknown fact is a P0 block', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Ghost ants are common', factIds: ['does_not_exist_01'] }],
      body: BODY,
      factsById: FACTS,
    });
    expect(r.findings.some((f) => f.code === 'CLAIM_CITES_UNKNOWN_FACT' && f.severity === 'P0')).toBe(true);
    expect(r.pass).toBe(false);
  });

  test('valid claim backed by an existing fact and present in body passes', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Ghost ants are common during warmer months in Sarasota', strength: 'directional', factIds: ['city_sarasota_pest_ghost_ants_01'] }],
      body: BODY,
      factsById: FACTS,
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test('superlative language with directional backing → P2 warning', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Ghost ants are the most common pest in Sarasota', factIds: ['city_sarasota_pest_ghost_ants_01'] }],
      body: 'Ghost ants are the most common pest in Sarasota.',
      factsById: FACTS,
    });
    expect(r.findings.some((f) => f.code === 'CLAIM_SUPERLATIVE_UNVERIFIED')).toBe(true);
    expect(r.pass).toBe(true); // P2 only
  });

  test('strength overreach (claim asserts verified on directional fact) → P2', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Ghost ants are common', strength: 'verified', factIds: ['city_sarasota_pest_ghost_ants_01'] }],
      body: 'Ghost ants are common.',
      factsById: FACTS,
    });
    expect(r.findings.some((f) => f.code === 'CLAIM_STRENGTH_OVERREACH')).toBe(true);
  });

  test('claim not found in body → P2 drift warning', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Subterranean termites swarm every April in coastal condos', factIds: ['city_sarasota_neighborhood_laurel_park_01'] }],
      body: 'This page is about ghost ants only.',
      factsById: FACTS,
    });
    expect(r.findings.some((f) => f.code === 'CLAIM_NOT_IN_BODY')).toBe(true);
  });

  test('disallowed phrase heuristic flags body content', () => {
    const r = v.validateLedger({
      claimsLedger: [{ claim: 'Laurel Park homes often need termite monitoring', factIds: ['city_sarasota_neighborhood_laurel_park_01'] }],
      body: 'Older homes in Laurel Park often need termite monitoring. We offer same-day availability for every customer.',
      factsById: FACTS,
      disallowedPatterns: ['Do not claim same-day availability'],
    });
    expect(r.findings.some((f) => f.code === 'DISALLOWED_PHRASE_SUSPECTED')).toBe(true);
  });
});

describe('disallowedTriggers', () => {
  test('strips the lead instruction and lifts the clause', () => {
    expect(v.disallowedTriggers('Do not claim same-day availability for Venice')).toEqual(['same-day availability']);
    expect(v.disallowedTriggers('Do not mention HOA restrictions unless manually verified')).toEqual(['hoa restrictions']);
  });
});
