jest.mock('../services/email/email-reply-amount-relations', () => {
  const actual = jest.requireActual('../services/email/email-reply-amount-relations');
  return { recognizeEmailReplyAmountRelations: jest.fn(actual.recognizeEmailReplyAmountRelations) };
});
const { recognizeEmailReplyAmountRelations: amounts } = require('../services/email/email-reply-amount-relations');
const { recognizeEmailReplyUnitRelations: recognize } = require('../services/email/email-reply-unit-relations');
const records = (text) => recognize(text).clauses.flatMap((clause) => clause.unitRelations);
const span = (start, end, text) => ({ start, end, text });
const unit = (start, kind, text) => ({ ...span(start, start + 1, text), kind });
const amount = (start, text = '$98', kind = 'money') => ({ ...span(start, start + 1, text), kind });
const candidate = (start, end, a, anchor = null, connector = null) => ({
  relation: 'amount_unit', start, end, amount: a, anchor, connector,
});

describe('inactive bounded unit relation candidates', () => {
  beforeEach(() => amounts.mockClear());

  test.each([
    ['unit', 'per visit'], ['application', 'per application'], ['timing', 'at the next visit'],
    ['forVisit', 'for a visit'], ['eachVisit', 'each visit'], ['visits', 'visits'],
    ['visit', 'a visit'], ['period', 'monthly'],
  ])('keeps %s without normalizing its kind in either direction', (kind, text) => {
    expect(records(`$98 ${text}`)).toEqual([{ unit: unit(1, kind, text), candidates: [
      candidate(0, 2, amount(0)),
    ] }]);
    expect(records(`${text} $98`)).toEqual([{ unit: unit(0, kind, text), candidates: [
      candidate(0, 2, amount(1)),
    ] }]);
  });

  test.each(['$98/mo', '$98 per month', '$98 yearly', '$98 annually'])
  ('uses the same lexical adjacency for periods: %s', (text) => {
    const record = records(text)[0];
    expect(record.unit).toEqual(unit(1, 'period', text.slice(3).trim()));
    expect(record.candidates).toEqual([candidate(0, 2, amount(0))]);
  });

  test('retains a bare number and intact range without inferring currency', () => {
    expect(records('98 per visit')).toEqual([{ unit: unit(1, 'unit', 'per visit'), candidates: [
      candidate(0, 2, amount(0, '98', 'number')),
    ] }]);
    expect(records('90 to 120 per visit')[0].candidates).toEqual([
      candidate(0, 2, amount(0, '90 to 120', 'number')),
    ]);
  });

  test('retains each visit noun and predicate alternatives with full original anchors', () => {
    const clause = recognize('Each visit costs $98').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations).toEqual([{ unit: unit(0, 'eachVisit', 'each visit'), candidates:
      original.candidates.map((anchor) => candidate(0, 3, original.amount, anchor)) }]);
    expect(clause.unitRelations[0].candidates.map((c) => c.anchor.relation))
      .toEqual(['head_amount', 'predicate_amount']);
    clause.unitRelations[0].candidates.forEach((c, i) => {
      expect(c.anchor).toBe(original.candidates[i]);
      expect(c.amount).toBe(original.amount);
    });
  });

  test('keeps distinct direct and anchored paths after the same amount', () => {
    const clause = recognize('costs $98 per visit').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations[0].candidates).toEqual([
      candidate(1, 3, original.amount),
      ...original.candidates.map((anchor) => candidate(0, 3, original.amount, anchor)),
    ]);
  });

  test('uses an amount-to-head span as the complete chosen anchor', () => {
    const clause = recognize('$98 is the price per visit').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations).toEqual([{ unit: unit(4, 'unit', 'per visit'), candidates: [
      candidate(0, 5, original.amount, original.candidates[0]),
    ] }]);
    expect(clause.unitRelations[0].candidates[0].anchor.connector).toEqual(span(1, 3, 'is the'));
  });

  test('retains negation, participant and qualifier evidence without a policy exemption', () => {
    const clause = recognize('per visit we will not charge you about $98').clauses[0];
    expect(clause.unitRelations[0].candidates).toEqual([]);
    const linked = recognize('per visit will not charge you about $98').clauses[0];
    const original = linked.amountRelations[0];
    const anchor = original.candidates.find((c) => c.relation === 'predicate_amount');
    expect(linked.unitRelations[0].candidates).toEqual([candidate(0, 7, original.amount, anchor)]);
    expect(anchor.anchor).toMatchObject({ negated: true, text: 'will not charge' });
    expect(anchor.connector).toEqual(span(4, 6, 'you about'));
    expect(anchor.qualifier).toMatchObject({ text: 'about' });
  });

  test.each([':', '-'])('permits exactly one separator %s in either direction', (separator) => {
    expect(records(`per visit ${separator} $98`)[0].candidates).toEqual([
      candidate(0, 3, amount(2), null, span(1, 2, separator)),
    ]);
    expect(records(`$98 ${separator} per visit`)[0].candidates).toEqual([
      candidate(0, 3, amount(0), null, span(1, 2, separator)),
    ]);
    const clause = recognize(`per visit ${separator} costs $98`).clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations[0].candidates).toEqual(original.candidates.map((anchor) =>
      candidate(0, 4, original.amount, anchor, span(1, 2, separator))));
  });

  test.each(['', 'we ', 'the customer '])
  ('permits fronted comma plus zero or one existing participant: %s', (participant) => {
    const clause = recognize(`for each visit, ${participant}charge $98`).clauses[0];
    const original = clause.amountRelations[0];
    const headStart = 2 + participant.trim().split(' ').filter(Boolean).length;
    expect(clause.unitRelations).toEqual([{ unit: unit(0, 'unit', 'for each visit'), candidates:
      original.candidates.map((anchor) => candidate(0, headStart + 2, original.amount,
        anchor, span(1, headStart, [',', participant.trim()].filter(Boolean).join(' ')))) }]);
    expect(clause.unitRelations[0].candidates.every((c) => c.anchor !== null)).toBe(true);
  });

  test('fronted comma accepts an amount-to-head anchor but excludes its bare path', () => {
    const clause = recognize('each visit, $98 fee').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations[0].candidates).toEqual([
      candidate(0, 4, original.amount, original.candidates[0], span(1, 2, ',')),
    ]);
  });

  test('periods use the same fronted-comma rule without plan interpretation', () => {
    const clause = recognize('monthly, we charge $98').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations).toEqual([{ unit: unit(0, 'period', 'monthly'), candidates:
      original.candidates.map((anchor) => candidate(0, 5, original.amount, anchor, span(1, 3, ', we'))) }]);
  });

  test.each(['each visit, $98', '$98, each visit', 'costs $98, each visit',
    'each visit,, costs $98', 'each visit, we you charge $98',
    'each visit, mystery charge $98', 'each visit we charge $98',
    'each visit: we charge $98', 'each visit, : charge $98', 'each visit - - $98'])
  ('leaves unsupported comma and separator forms unresolved: %s', (text) => {
    expect(records(text).every((record) => record.candidates.length === 0)).toBe(true);
  });

  test.each(['mystery', 'and', '98 minutes', '@', '/', '(', ')', ': -', '- :'])
  ('does not cross unsupported intervening tokens: %s', (gap) => {
    expect(records(`per visit ${gap} $98`)[0].candidates).toEqual([]);
    expect(records(`$98 ${gap} per visit`).at(-1).candidates).toEqual([]);
  });

  test('does not cross other units or amounts', () => {
    const clause = recognize('per visit per application $98 $120').clauses[0];
    expect(clause.unitRelations[0].candidates).toEqual([]);
    expect(clause.unitRelations[1].candidates).toEqual([candidate(1, 3, amount(2))]);
  });

  test('links each amount only to its adjacent application or period', () => {
    expect(records('$98 per application and $1176 yearly')).toEqual([
      { unit: unit(1, 'application', 'per application'), candidates: [candidate(0, 2, amount(0))] },
      { unit: unit(4, 'period', 'yearly'), candidates: [candidate(3, 5, amount(3, '$1176'))] },
    ]);
  });

  test('retains unresolved periods inside plan language and direct visit edges separately', () => {
    expect(records('monthly plan costs $98')).toEqual([
      { unit: unit(0, 'period', 'monthly'), candidates: [] },
    ]);
    const clause = recognize('monthly plan costs $98 per visit').clauses[0];
    const original = clause.amountRelations[0];
    expect(clause.unitRelations[0]).toEqual({ unit: unit(0, 'period', 'monthly'), candidates: [] });
    expect(clause.unitRelations[1].candidates).toEqual([
      candidate(3, 5, original.amount),
      ...original.candidates.map((anchor) => candidate(2, 5, original.amount, anchor)),
    ]);
    expect(records('$98 per application and includes a visit')).toEqual([
      { unit: unit(1, 'application', 'per application'), candidates: [candidate(0, 2, amount(0))] },
      { unit: unit(4, 'visit', 'a visit'), candidates: [] },
    ]);
    expect(records('a visit in the monthly plan costs $98').every((r) => !r.candidates.length)).toBe(true);
  });

  test.each(['98 minutes per visit', 'pay you a visit'])('retains units with no amount: %s', (text) => {
    const clause = recognize(text).clauses[0];
    expect(clause.amountRelations).toEqual([]);
    expect(clause.unitRelations).toHaveLength(1);
    expect(clause.unitRelations[0].candidates).toEqual([]);
  });

  test.each([';', '.', '!', '?'])('resets spans and does not cross clauses: %s', (boundary) => {
    const result = recognize(`per visit ${boundary}\n$98 ${boundary} $120 per application`);
    expect(result.clauses[0].unitRelations).toEqual([{ unit: unit(0, 'unit', 'per visit'), candidates: [] }]);
    expect(result.clauses[1].unitRelations).toEqual([]);
    expect(result.clauses[2].unitRelations).toEqual([
      { unit: unit(1, 'application', 'per application'), candidates: [candidate(0, 2, amount(0, '$120'))] },
    ]);
  });

  test('calls upstream once, preserves every upstream field and identity, and never mutates it', () => {
    const original = jest.requireActual('../services/email/email-reply-amount-relations')
      .recognizeEmailReplyAmountRelations('costs $98 per visit; for each visit, we charge $120');
    original.extra = { evidence: true };
    original.disposition = 'future_disposition';
    original.clauses[0].extra = { clauseEvidence: true };
    const snapshot = JSON.parse(JSON.stringify(original));
    const freeze = (value) => {
      Object.values(value).forEach((child) => { if (child && typeof child === 'object') freeze(child); });
      return Object.freeze(value);
    };
    amounts.mockReturnValueOnce(freeze(original));
    const result = recognize('fixture');
    expect(amounts).toHaveBeenCalledTimes(1);
    expect(amounts).toHaveBeenCalledWith('fixture');
    expect(result).toMatchObject({ ...original, disposition: 'needs_review' });
    expect(result.extra).toBe(original.extra);
    result.clauses.forEach((clause, i) => {
      for (const key of Object.keys(original.clauses[i])) expect(clause[key]).toBe(original.clauses[i][key]);
      clause.unitRelations.flatMap((r) => r.candidates).forEach((c) => {
        const record = clause.amountRelations.find((r) => r.amount === c.amount);
        expect(record).toBeDefined();
        if (c.anchor) expect(record.candidates.some((anchor) => anchor === c.anchor)).toBe(true);
      });
    });
    expect(original).toEqual(snapshot);
    result.clauses[0].unitRelations[0].candidates.push('caller mutation');
    expect(result.clauses[1].unitRelations[0].candidates).toHaveLength(2);
    expect(records('costs $98 per visit')[0].candidates).toHaveLength(3);
  });

  test.each([null, {}, 'a'.repeat(8193), 'a '.repeat(513),
    '*_'.repeat(40) + '$98 per visit' + '_*'.repeat(40)])
  ('propagates bounded upstream failures unchanged: %#', (text) => {
    const result = recognize(text);
    expect(amounts).toHaveBeenCalledTimes(1);
    expect(result).toBe(amounts.mock.results[0].value);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('disposition');
  });

  test('propagates unknown failures and exceptions', () => {
    const failure = { ok: false, reason: 'future_failure', extra: true };
    amounts.mockReturnValueOnce(failure);
    expect(recognize('fixture')).toBe(failure);
    amounts.mockImplementationOnce(() => { throw new Error('upstream'); });
    expect(() => recognize('fixture')).toThrow('upstream');
  });

  test('keeps empty and unknown successful input for review', () => {
    expect(recognize()).toEqual({ ok: true, disposition: 'needs_review', clauses: [] });
    expect(records('the sky is blue')).toEqual([]);
    expect(amounts).toHaveBeenNthCalledWith(1, '');
  });

  test('handles a dense repeated amount/unit fixture with bounded candidate counts', () => {
    const result = recognize('$98/visit '.repeat(256));
    expect(result.ok).toBe(true);
    expect(result.clauses[0].tokens).toHaveLength(512);
    expect(result.clauses[0].unitRelations).toHaveLength(256);
    expect(result.clauses[0].unitRelations.every((r) => r.candidates.length <= 2)).toBe(true);
  });
});
