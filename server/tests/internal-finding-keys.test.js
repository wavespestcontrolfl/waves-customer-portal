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
  test("a paid/collected fee's OWN amount still redacts — payment state is not a breaker", () => {
    expect(redactInspectionFeeCues('Inspection fee paid at closing: $250'))
      .toBe('Inspection fee paid at closing: [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee collected on site: $250'))
      .toBe('Inspection fee collected on site: [fee removed]');
  });
  test('"at" is not a bare-number introducer — street numbers survive', () => {
    expect(redactInspectionFeeCues('The inspection fee for the property at 123 Main Street is $250'))
      .toBe('The inspection fee for the property at 123 Main Street is [fee removed]');
  });
  test('area measurements are never selected as the amount', () => {
    expect(redactInspectionFeeCues('Inspection fee for a home of 2500 square feet is $250'))
      .toBe('Inspection fee for a home of 2500 square feet is [fee removed]');
    expect(redactInspectionFeeCues('Home of 2400 sq ft; inspection fee is 175.'))
      .toBe('Home of 2400 sq ft; inspection fee [fee removed].');
  });
  test('money-subject nouns end the cue reach — customer financials survive', () => {
    expect(redactInspectionFeeCues('Inspection fee paid separately, purchase price $400,000.'))
      .toBe('Inspection fee paid separately, purchase price $400,000.');
    expect(redactInspectionFeeCues('Inspection fee paid separately, closing costs $12,000.'))
      .toBe('Inspection fee paid separately, closing costs $12,000.');
    expect(redactInspectionFeeCues('Inspection fee on file, home value $400,000.'))
      .toBe('Inspection fee on file, home value $400,000.');
  });
  test('amount-first constructions keep their subject — the amount is never the fee', () => {
    expect(redactInspectionFeeCues('Inspection fee paid separately, $400,000 purchase price.'))
      .toBe('Inspection fee paid separately, $400,000 purchase price.');
    expect(redactInspectionFeeCues('Inspection fee paid separately, $400 balance remains.'))
      .toBe('Inspection fee paid separately, $400 balance remains.');
    // direct adjacency only — a fee amount followed by ordinary prose still redacts
    expect(redactInspectionFeeCues('Inspection fee $250 for the treatment area.'))
      .toBe('Inspection fee [fee removed] for the treatment area.');
  });
  test('cost/charge/price/run directly after the cue bridge the fee, not a new subject', () => {
    expect(redactInspectionFeeCues('Inspection fee costs $250.'))
      .toBe('Inspection fee costs [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee runs $175.'))
      .toBe('Inspection fee runs [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee will cost $250.'))
      .toBe('Inspection fee will cost [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee generally costs $250.'))
      .toBe('Inspection fee generally costs [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee has a cost of $250.'))
      .toBe('Inspection fee has a cost of [fee removed].');
  });
  test('a determined amount belongs to something else — home/escrow prose survives', () => {
    expect(redactInspectionFeeCues('Inspection fee covered by seller for the $400,000 home.'))
      .toBe('Inspection fee covered by seller for the $400,000 home.');
    expect(redactInspectionFeeCues('Inspection fee was paid from the $500 escrow deposit.'))
      .toBe('Inspection fee was paid from the $500 escrow deposit.');
  });
  test('abbreviation periods do not end the cue reach', () => {
    expect(redactInspectionFeeCues('Inspection fee approx. $250'))
      .toBe('Inspection fee approx. [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee est. at $250'))
      .toBe('Inspection fee est. at [fee removed]');
    // a word merely ending in the abbreviation letters still terminates
    expect(redactInspectionFeeCues('The fee was modest. Total due $400.'))
      .toBe('The fee was modest. Total due $400.');
  });
  test('slash-separated and qualified fee alternatives are fully consumed', () => {
    expect(redactInspectionFeeCues('Inspection fee $175/$250.'))
      .toBe('Inspection fee [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee is $175 for block homes and $250 for wood-frame homes.'))
      .toBe('Inspection fee is [fee removed] for wood-frame homes.');
    // a qualifier naming a new money subject is never swallowed
    expect(redactInspectionFeeCues('Inspection fee $250 for repairs and $500 deductible.'))
      .toBe('Inspection fee [fee removed] for repairs and $500 deductible.');
  });
  test('every amount in a fee range is consumed into one redaction', () => {
    expect(redactInspectionFeeCues('Inspection fee ranges from $175 to $250 depending on construction.'))
      .toBe('Inspection fee ranges from [fee removed] depending on construction.');
    expect(redactInspectionFeeCues('Inspection fee $175–$250.'))
      .toBe('Inspection fee [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee is either $175 or $250 depending on size.'))
      .toBe('Inspection fee is either [fee removed] depending on size.');
    expect(redactInspectionFeeCues('Inspection fee between 175 and 250.'))
      .toBe('Inspection fee [fee removed].');
    // a connector followed by a NEW subject is not part of the range
    expect(redactInspectionFeeCues('Inspection fee $175 and treatment estimate $900.'))
      .toBe('Inspection fee [fee removed] and treatment estimate $900.');
  });
  test('an included/covered fee still redacts its own amount', () => {
    expect(redactInspectionFeeCues('Inspection fee included on invoice: $250'))
      .toBe('Inspection fee included on invoice: [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee is included in closing costs: $250'))
      .toBe('Inspection fee is included in closing costs: [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee covered by seller: $250'))
      .toBe('Inspection fee covered by seller: [fee removed]');
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
