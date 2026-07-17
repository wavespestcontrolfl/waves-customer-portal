// The internal-key strip is the single guarantee behind three egress points
// (public /data payload, narrative prompt, report assistant) — codex P2 #2807
// flagged that filtering only the payload lets the narrative echo the fee, so
// the strip is centralized in project-types and applied at every boundary.
const {
  INTERNAL_FINDING_KEYS,
  stripInternalFindingKeys,
  redactInspectionFeeCues,
  redactInspectionFeeCuesForType,
  projectTypeHasInternalFindingKeys,
} = require('../services/project-types');

describe('stripInternalFindingKeys', () => {
  test('inspection_fee is an internal key', () => {
    expect(INTERNAL_FINDING_KEYS).toContain('inspection_fee');
  });

  test('drops internal keys, keeps customer-facing ones', () => {
    expect(stripInternalFindingKeys({
      wdo_finding: 'No visible signs of WDO observed',
      inspection_fee: 'Tier 2 — $250',
    })).toEqual({ wdo_finding: 'No visible signs of WDO observed' });
  });

  test('parses a JSON string and strips', () => {
    expect(stripInternalFindingKeys('{"a":"1","inspection_fee":"$250"}')).toEqual({ a: '1' });
  });

  test('null / non-object inputs pass through without throwing', () => {
    expect(stripInternalFindingKeys(null)).toBeNull();
    expect(stripInternalFindingKeys(undefined)).toBeUndefined();
    expect(stripInternalFindingKeys('not json')).toEqual({});
  });

  test('redacts fee cues inside free-text finding VALUES (WDO comments path)', () => {
    expect(stripInternalFindingKeys({
      comments: 'Buyer to pay at closing. Inspection fee $250 collected on site.',
      wdo_finding: 'No visible signs of WDO observed',
    })).toEqual({
      comments: 'Buyer to pay at closing. Inspection fee [fee removed] collected on site.',
      wdo_finding: 'No visible signs of WDO observed',
    });
  });

  test('walks nested values so structure cannot smuggle the fee through', () => {
    expect(stripInternalFindingKeys({
      areas: ['Attic clear', 'Inspection fee $95 noted'],
      details: { note: 'inspection fee due: $250' },
    })).toEqual({
      areas: ['Attic clear', 'Inspection fee [fee removed] noted'],
      details: { note: 'inspection fee due: [fee removed]' },
    });
  });

  test('drops internal keys at every depth, not just top level', () => {
    expect(stripInternalFindingKeys({
      details: { inspection_fee: '$250', other: 'kept' },
      items: [{ inspection_fee: '175' }, { note: 'clear' }],
    })).toEqual({
      details: { other: 'kept' },
      items: [{}, { note: 'clear' }],
    });
  });

  test('value scrub is gated off for types with no internal fee field', () => {
    const findings = { comments: 'A follow-up inspection fee of $100 applies.' };
    expect(stripInternalFindingKeys(findings, { redactValues: false }))
      .toEqual({ comments: 'A follow-up inspection fee of $100 applies.' });
  });
});

describe('type gating', () => {
  test('only WDO carries the internal fee field; unknown types fail closed', () => {
    expect(projectTypeHasInternalFindingKeys('wdo_inspection')).toBe(true);
    expect(projectTypeHasInternalFindingKeys('rodent_trapping')).toBe(false);
    expect(projectTypeHasInternalFindingKeys('no_such_type')).toBe(true);
  });

  test('redactInspectionFeeCuesForType leaves non-fee types untouched', () => {
    const disclosure = 'A follow-up inspection fee of $100 applies.';
    expect(redactInspectionFeeCuesForType(disclosure, 'rodent_trapping')).toBe(disclosure);
    expect(redactInspectionFeeCuesForType(disclosure, 'wdo_inspection')).toContain('[fee removed]');
  });
});

describe('redactInspectionFeeCues', () => {
  test('removes inspection-fee language + amount, keeps a legitimate estimate', () => {
    expect(redactInspectionFeeCues('Inspection fee $250. Repair cost $1,250 for the sill plate.'))
      .toBe('Inspection fee [fee removed]. Repair cost $1,250 for the sill plate.');
  });
  test('requires the literal "inspection fee" phrase — never a bare or generic fee', () => {
    expect(redactInspectionFeeCues('The inspection fee is $250 today.')).toBe('The inspection fee is [fee removed] today.');
    expect(redactInspectionFeeCues('The fee is $250 today.')).toBe('The fee is $250 today.');
    expect(redactInspectionFeeCues('Repair fee $1,250.')).toBe('Repair fee $1,250.');
    expect(redactInspectionFeeCues('Permit fee is $125.')).toBe('Permit fee is $125.');
    expect(redactInspectionFeeCues('Treatment fee for the follow-up is $90.')).toBe('Treatment fee for the follow-up is $90.');
    expect(redactInspectionFeeCues('Repair cost $1,250.')).toBe('Repair cost $1,250.');
  });
  test('catches a stale fee via language, regardless of the current value', () => {
    expect(redactInspectionFeeCues('Inspection fee $250 quoted earlier.')).toContain('[fee removed]');
  });
  test('reaches across a long bridging clause — no fixed character window', () => {
    expect(redactInspectionFeeCues('The inspection fee is due at time of service: $250'))
      .toBe('The inspection fee is due at time of service: [fee removed]');
  });
  test('a waived/paid fee never swallows a later unrelated amount', () => {
    expect(redactInspectionFeeCues('Inspection fee waived; repair $1,250.'))
      .toBe('Inspection fee waived; repair $1,250.');
    expect(redactInspectionFeeCues('Inspection fee waived, repair estimate $1,250.'))
      .toBe('Inspection fee waived, repair estimate $1,250.');
    expect(redactInspectionFeeCues('Inspection fee paid, balance $400 due at close.'))
      .toBe('Inspection fee paid, balance $400 due at close.');
  });
  test('a new money subject ends the cue reach', () => {
    expect(redactInspectionFeeCues('Inspection fee noted, treatment estimate $900.'))
      .toBe('Inspection fee noted, treatment estimate $900.');
    expect(redactInspectionFeeCues('Inspection fee applies; permit $125 billed separately.'))
      .toBe('Inspection fee applies; permit $125 billed separately.');
  });
  test('a paid/collected fee never swallows a later total', () => {
    expect(redactInspectionFeeCues('Inspection fee paid separately, total due $400.'))
      .toBe('Inspection fee paid separately, total due $400.');
    expect(redactInspectionFeeCues('Inspection fee collected on site; amount due $150.'))
      .toBe('Inspection fee collected on site; amount due $150.');
  });
  test('redacts currency-word and bare-number amounts, not just $', () => {
    expect(redactInspectionFeeCues('Inspection fee is 250 dollars.'))
      .toBe('Inspection fee is [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee: USD 250'))
      .toBe('Inspection fee: [fee removed]');
    // the bare form consumes its own is/was/of/at introducer
    expect(redactInspectionFeeCues('The inspection fee of 175 was quoted on the phone.'))
      .toBe('The inspection fee [fee removed] was quoted on the phone.');
    expect(redactInspectionFeeCues('Inspection fee: 250'))
      .toBe('Inspection fee [fee removed]');
  });
  test('a bare number without a value introducer is never selected — the real amount still is', () => {
    expect(redactInspectionFeeCues('Inspection fee for 123 Main Street is $250'))
      .toBe('Inspection fee for 123 Main Street is [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee per invoice 4482 applies.'))
      .toBe('Inspection fee per invoice 4482 applies.');
  });
  test('bare-number guards: durations, dates, times, and years survive', () => {
    expect(redactInspectionFeeCues('Inspection fee due in 30 days.'))
      .toBe('Inspection fee due in 30 days.');
    expect(redactInspectionFeeCues('Inspection fee due 07/24 at the office.'))
      .toBe('Inspection fee due 07/24 at the office.');
    expect(redactInspectionFeeCues('Inspection fee due by 10:30 am tomorrow.'))
      .toBe('Inspection fee due by 10:30 am tomorrow.');
    expect(redactInspectionFeeCues('Inspection fee for 2026 renewals to be announced.'))
      .toBe('Inspection fee for 2026 renewals to be announced.');
    expect(redactInspectionFeeCues('Inspection fee tier 2 selected.'))
      .toBe('Inspection fee tier 2 selected.');
  });
  test('leaves fee-free prose and preserves line breaks', () => {
    expect(redactInspectionFeeCues('Monitor bait stations quarterly.')).toBe('Monitor bait stations quarterly.');
    const out = redactInspectionFeeCues('WHAT WE DID\n\nInspection fee $250.\n\nWHAT WE FOUND');
    expect((out.match(/\n/g) || []).length).toBe(4);
  });
});
