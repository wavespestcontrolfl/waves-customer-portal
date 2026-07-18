// The internal-key strip is the single guarantee behind three egress points
// (public /data payload, narrative prompt, report assistant) — codex P2 #2807
// flagged that filtering only the payload lets the narrative echo the fee, so
// the strip is centralized in project-types and applied at every boundary.
const {
  INTERNAL_FINDING_KEYS,
  stripInternalFindingKeys,
  redactInspectionFeeCues,
  redactInspectionFeeCuesForType,
  redactProjectTitleForWrite,
  projectTypeHasInternalFindingKeys,
  PROJECT_TITLE_MAX_LENGTH,
} = require('../services/project-types');
const { redactSpecificAmounts } = require('@waves/report-redaction');

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

describe('free-text gating and default fee', () => {
  const { projectTypeFreeTextKeys, projectRecordedFeeValues, WDO_DEFAULT_INSPECTION_FEE } = require('../services/project-types');
  test('the value pass never touches structured fields — street numbers survive', () => {
    const out = stripInternalFindingKeys({
      property_address: '175 Main Street',
      comments: 'Buyer asked whether the $175 charge is due.',
      inspection_fee: '175',
    }, { redactValues: true, feeValues: ['175'], freeTextKeys: projectTypeFreeTextKeys('wdo_inspection') });
    expect(out.property_address).toBe('175 Main Street');
    expect(out.comments).toBe('Buyer asked whether the [fee removed] charge is due.');
    expect(out.inspection_fee).toBeUndefined();
  });
  test('a blank fee falls back to the flat WDO default for the value pass', () => {
    expect(projectRecordedFeeValues({ findings: {} })).toEqual([WDO_DEFAULT_INSPECTION_FEE]);
    expect(projectRecordedFeeValues({ findings: { inspection_fee: '175' } })).toEqual(['175']);
  });
});

describe('redactSpecificAmounts (legacy backfill value scrub)', () => {
  test('removes the recorded fee value even when the prose paraphrases it', () => {
    expect(redactSpecificAmounts('We quoted the $250 charge for this visit.', ['250']))
      .toBe('We quoted the [fee removed] charge for this visit.');
    expect(redactSpecificAmounts('Buyer asked whether the $250 charge is due at closing.', ['250']))
      .toBe('Buyer asked whether the [fee removed] charge is due at closing.');
    expect(redactSpecificAmounts('The WDO inspection costs 250 dollars today.', ['$250']))
      .toBe('The WDO inspection costs [fee removed] today.');
  });
  test('a coincidental match with another money subject is never corrupted', () => {
    expect(redactSpecificAmounts('Repair cost $250 for the sill plate.', ['250']))
      .toBe('Repair cost $250 for the sill plate.');
    expect(redactSpecificAmounts('Treatment estimate $250 approved.', ['250']))
      .toBe('Treatment estimate $250 approved.');
    // amount-first non-fee subjects too
    expect(redactSpecificAmounts('A $250 repair was completed.', ['250']))
      .toBe('A $250 repair was completed.');
    expect(redactSpecificAmounts('$250 permit fee paid separately.', ['250']))
      .toBe('$250 permit fee paid separately.');
  });
  test('never touches longer numbers, dates, or measurements', () => {
    expect(redactSpecificAmounts('Fee tier 2 applies to 2500 sq ft homes.', ['250']))
      .toBe('Fee tier 2 applies to 2500 sq ft homes.');
    expect(redactSpecificAmounts('Visit on 07/250 untouched.', ['250']))
      .toBe('Visit on 07/250 untouched.');
    expect(redactSpecificAmounts('Fee tier 2 mentioned, and the $2,250 quote is unrelated.', ['Tier 2 — $250']))
      .toBe('Fee tier 2 mentioned, and the $2,250 quote is unrelated.');
  });
  test('parses the monetary amount out of tier-style labels', () => {
    expect(redactSpecificAmounts('We quoted the $250 charge for this visit.', ['Tier 2 — $250']))
      .toBe('We quoted the [fee removed] charge for this visit.');
  });
  test('a zero-dollar fee never scrubs legitimate zeros', () => {
    expect(redactSpecificAmounts('0 live termites observed in 0 areas.', ['$0.00']))
      .toBe('0 live termites observed in 0 areas.');
    expect(redactSpecificAmounts('0 live termites observed in 0 areas.', ['0']))
      .toBe('0 live termites observed in 0 areas.');
  });
});

describe('redactProjectTitleForWrite', () => {
  test('a scrubbed title never exceeds the varchar(200) column', () => {
    const nearLimit = `${'x'.repeat(180)} inspection fee $1`;
    const scrubbed = redactProjectTitleForWrite(nearLimit, 'wdo_inspection');
    expect(scrubbed.length).toBeLessThanOrEqual(PROJECT_TITLE_MAX_LENGTH);
    expect(scrubbed).not.toContain('$1');
  });
  test('non-fee types pass through untouched', () => {
    const title = 'Rodent trapping — inspection fee $100 applies';
    expect(redactProjectTitleForWrite(title, 'rodent_trapping')).toBe(title);
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
  test('a fee ending a line still redacts when the next line opens with a subject word', () => {
    expect(redactInspectionFeeCues('Inspection fee $250\nRepair notes follow'))
      .toBe('Inspection fee [fee removed]\nRepair notes follow');
  });
  test('a payment-agent phrase bridges; a new payer breaks', () => {
    expect(redactInspectionFeeCues('Inspection fee paid by seller: $250'))
      .toBe('Inspection fee paid by seller: [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee paid by seller, buyer paid $400 at closing.'))
      .toBe('Inspection fee paid by seller, buyer paid $400 at closing.');
  });
  test('a wrapped amount on the next line redacts; paragraphs stay bounded', () => {
    expect(redactInspectionFeeCues('Inspection fee:\n$250'))
      .toBe('Inspection fee:\n[fee removed]');
    expect(redactInspectionFeeCues('Inspection fee waived\nRepair notes: $1,250 for sill plate'))
      .toBe('Inspection fee waived\nRepair notes: $1,250 for sill plate');
    // a blank line (two breaks) always terminates the cue
    expect(redactInspectionFeeCues('Inspection fee\n\n$250 deposit due'))
      .toBe('Inspection fee\n\n$250 deposit due');
  });
  test('a bare property noun breaks; the prepositional object bridges', () => {
    expect(redactInspectionFeeCues('Inspection fee paid separately, the property sold for $400,000.'))
      .toBe('Inspection fee paid separately, the property sold for $400,000.');
    expect(redactInspectionFeeCues('The inspection fee for the property at 123 Main Street is $250'))
      .toBe('The inspection fee for the property at 123 Main Street is [fee removed]');
  });
  test('a trailing comma is punctuation, not a digit separator', () => {
    expect(redactInspectionFeeCues('Inspection fee was $250, then the inspection continued.'))
      .toBe('Inspection fee was [fee removed], then the inspection continued.');
  });
  test('a money-noun proper name inside a street address never breaks the cue', () => {
    expect(redactInspectionFeeCues('Inspection fee for the property at 123 Price Street is $250'))
      .toBe('Inspection fee for the property at 123 Price Street is [fee removed]');
    expect(redactInspectionFeeCues('Inspection fee at 42 Value Lane: USD 250'))
      .toBe('Inspection fee at 42 Value Lane: [fee removed]');
  });
  test('a conjunction between amount and cue is two statements — no pre-cue match', () => {
    expect(redactInspectionFeeCues('Treatment is $900 and inspection fee waived.'))
      .toBe('Treatment is $900 and inspection fee waived.');
    expect(redactInspectionFeeCues('Repair is $1,250 while inspection fee is waived.'))
      .toBe('Repair is $1,250 while inspection fee is waived.');
  });
  test('a pre-cue fee never triggers a forward match on a later amount', () => {
    expect(redactInspectionFeeCues('The $250 inspection fee was collected at closing with $400 held in escrow.'))
      .toBe('The [fee removed] inspection fee was collected at closing with $400 held in escrow.');
  });
  test('fee-free text passes through byte-identical — hash stability', () => {
    expect(redactInspectionFeeCues('No evidence.  Accessible areas only.'))
      .toBe('No evidence.  Accessible areas only.');
    expect(redactInspectionFeeCues('  padded fee-free text  '))
      .toBe('  padded fee-free text  ');
  });
  test('an amount BEFORE the cue redacts; a distant amount does not', () => {
    expect(redactInspectionFeeCues('The $250 inspection fee was collected at closing.'))
      .toBe('The [fee removed] inspection fee was collected at closing.');
    expect(redactInspectionFeeCues('A $175 WDO inspection fee applies.'))
      .toBe('A [fee removed] WDO inspection fee applies.');
    expect(redactInspectionFeeCues('$1,250 repair completed near the inspection fee area.'))
      .toBe('$1,250 repair completed near the inspection fee area.');
    // a range before the cue is consumed whole — no bound survives
    expect(redactInspectionFeeCues('The $175-$250 inspection fee depends on construction.'))
      .toBe('The [fee removed] inspection fee depends on construction.');
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
  test('a threshold amount after under/value survives; scope phrases keep the fee', () => {
    expect(redactInspectionFeeCues('Inspection fee applies to properties under a value of $400,000.'))
      .toBe('Inspection fee applies to properties under a value of $400,000.');
    expect(redactInspectionFeeCues('Inspection fee for the WDO treatment is $250.'))
      .toBe('Inspection fee for the WDO treatment is [fee removed].');
    expect(redactInspectionFeeCues('Inspection fee for the treatment estimate $900.'))
      .toBe('Inspection fee for the treatment estimate $900.');
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
