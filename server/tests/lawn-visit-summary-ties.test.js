// GATE_LAWN_REPORT_FACTS: the Visit Summary's finding-to-product tie (version 4). A fixed match table, kind to
// kind, decided at completion (lawn-report-facts.js) and written as fixed sentences by code. Version 3 entries
// still render exactly as they were frozen. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const summary = require('../services/service-report/lawn-visit-summary');
const { gatherVisitSummaryFacts } = require('../services/service-report/lawn-visit-summary-inputs');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { lawnResultTimingViolation } = require('../services/service-report/report-writer-rules');
const { splitSentences } = require('../services/service-report/next-visit-claims');

const areas = (o) => Object.entries(o).map(([key, status]) => ({ key, status }));
const photo = (kind, label, product, sure = true) => ({ source: 'photo', kind, label, sure, product });
const tech = (kind, product) => ({ source: 'technician', kind, product });
const compose = (facts) => summary.composeVisitSummary({ season: 'fall', applied: [{ name: 'x', kind: 'fungicide' }], areas: [], findings: [], ...facts });

describe('the tie sentences (fixed, chosen from the facts)', () => {
  test('matched and confident', () => {
    expect(summary.render(summary.buildSlots({ applied: [], ties: [photo('fungus', 'gray leaf spot', 'fungicide')] })))
      .toBe('Today’s photos showed gray leaf spot in one area. Today’s visit included a fungicide treatment.');
  });

  test('matched, low confidence: hedged, and it says what was done', () => {
    expect(summary.render(summary.buildSlots({ applied: [], ties: [photo('weeds', 'weed pressure', 'herbicide', false)] })))
      .toBe('Today’s photos showed what may be weed pressure in one area, and today’s visit included a spot treatment for weeds.');
  });

  test.each([
    ['fungus', 'gray leaf spot', 'fungicide', 'a fungicide treatment'],
    ['weeds', 'weed pressure', 'herbicide', 'a spot treatment for weeds'],
    ['insects', 'chinch bug activity', 'insecticide', 'a spot treatment for insects'],
    ['drought', 'drought stress', 'wetting_agent', 'a wetting agent treatment'],
  ])('%s <-> %s', (kind, label, product, phrase) => {
    const text = summary.render(summary.buildSlots({ applied: [], ties: [photo(kind, label, product)] }));
    expect(text).toBe(`Today’s photos showed ${label} in one area. Today’s visit included ${phrase}.`);
  });

  test('a finding with NO matching product is checked by hand (never a promised treatment), on a recurring visit with a real next visit and a concern on the card', () => {
    const facts = {
      applied: [{ name: 'x', kind: 'fertilizer' }],
      areas: areas({ damage_disease_signals: 'watch' }),
      ties: [photo('fungus', 'gray leaf spot', null)],
      recurring: true,
      nextVisitBooked: true,
    };
    const text = summary.render(summary.buildSlots(facts));
    expect(text).toContain('Today’s photos showed what may be gray leaf spot in one area. We will check it by hand at the next visit.');
    expect(text).not.toMatch(/treat(ed)? (that|the) spot/);
  });

  test('...and says nothing when the visit is not recurring, has no booked next visit, or the card shows no concern', () => {
    const base = { applied: [{ name: 'x', kind: 'fertilizer' }], ties: [photo('fungus', 'gray leaf spot', null)] };
    for (const extra of [
      { areas: areas({ damage_disease_signals: 'watch' }), recurring: false, nextVisitBooked: true },
      { areas: areas({ damage_disease_signals: 'watch' }), recurring: true, nextVisitBooked: false },
      { areas: areas({ damage_disease_signals: 'healthy' }), recurring: true, nextVisitBooked: true },
      { areas: [], recurring: true, nextVisitBooked: true },
    ]) {
      expect(summary.render(summary.buildSlots({ ...base, ...extra }))).not.toContain('check it by hand');
    }
  });

  test('an unmatched drought finding never prints (the watering banner owns water)', () => {
    const text = summary.render(summary.buildSlots({
      applied: [{ name: 'x', kind: 'fertilizer' }],
      areas: areas({ damage_disease_signals: 'needs_attention' }),
      ties: [photo('drought', 'drought stress', null)],
      recurring: true,
      nextVisitBooked: true,
    }));
    expect(text).not.toContain('drought');
  });

  test('a product with no matching finding has no tie sentence (nothing is added)', () => {
    const withoutTies = summary.composeVisitSummary({ season: 'fall', applied: [{ name: 'x', kind: 'fungicide' }], areas: [], findings: [] });
    const withEmpty = summary.composeVisitSummary({ season: 'fall', applied: [{ name: 'x', kind: 'fungicide' }], areas: [], findings: [], ties: [] });
    expect(withEmpty.paragraph).toBe(withoutTies.paragraph);
    expect(withoutTies.paragraph).not.toMatch(/photos showed|technician found/);
    expect(withoutTies.slots).not.toHaveProperty('ties');
  });

  test('the technician\'s tap: found and treated', () => {
    for (const [kind, product, found] of [['chinch', 'insecticide', 'chinch bugs'], ['caterpillars', 'insecticide', 'caterpillars'], ['fungus', 'fungicide', 'signs of fungus']]) {
      expect(summary.render(summary.buildSlots({ applied: [], ties: [tech(kind, product)] })))
        .toBe(`Your technician found ${found} and treated that spot today.`);
    }
  });

  test('a finding the tie already states is not listed again in "In the photos we noticed"', () => {
    const slots = summary.buildSlots({
      applied: [],
      areas: areas({ weed_pressure: 'watch' }),
      findings: [{ label: 'weed pressure', confidence: 'high' }, { label: 'thinning turf', confidence: 'high' }],
      ties: [photo('weeds', 'weed pressure', 'herbicide')],
    });
    expect(slots.findings.map((f) => f.label)).toEqual([]);
    const withThin = summary.buildSlots({
      applied: [],
      areas: areas({ weed_pressure: 'watch', coverage: 'watch' }),
      findings: [{ label: 'weed pressure', confidence: 'high' }, { label: 'thinning turf', confidence: 'high' }],
      ties: [photo('weeds', 'weed pressure', 'herbicide')],
    });
    expect(withThin.findings.map((f) => f.label)).toEqual(['thinning turf']);
  });

  test('a score card whose topic a tie already states is not read out again; other cards still are', () => {
    const text = summary.render(summary.buildSlots({
      applied: [{ name: 'x', kind: 'fungicide' }],
      areas: areas({ damage_disease_signals: 'watch', weed_pressure: 'watch', coverage: 'strong' }),
      ties: [photo('fungus', 'gray leaf spot', 'fungicide'), tech('chinch', 'insecticide')],
    }));
    expect(text).toContain('Our photo read shows thick coverage, along with some weeds we are keeping an eye on.');
    expect(text).not.toContain('stress we are keeping an eye on');
  });

  test('ties come after the findings; at most two print; the results line is the first to give way to them under the cap', () => {
    const text = summary.render(summary.buildSlots({
      season: 'fall',
      applied: [{ name: 'x', kind: 'fungicide' }],
      areas: areas({ coverage: 'watch' }),
      findings: [{ label: 'thinning turf', confidence: 'high' }],
      ties: [photo('fungus', 'gray leaf spot', 'fungicide'), tech('chinch', 'insecticide'), photo('weeds', 'weed pressure', 'herbicide')],
      recurring: true,
      nextVisitBooked: true,
      watchNext: ['weeds'],
    }));
    const order = ['Today we applied', 'In the photos we noticed', 'Today’s photos showed gray leaf spot', 'Your technician found chinch bugs', 'At the next visit'];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).not.toContain('Results from treatments');
    expect(text).not.toContain('weed pressure in one area');
    expect(splitSentences(text).length).toBeLessThanOrEqual(summary.MAX_SENTENCES);
  });

  describe('the six-sentence cap counts individual sentences, and a tie is never cut in half', () => {
    // Two ties of two sentences each, with every other part present: nine sentences before the cap
    // (applied 1, area read 1, finding 1, tie 2, tie 2, results 1, next visit 1).
    const full = {
      season: 'winter',
      applied: ['fungicide'],
      areas: [{ key: 'coverage', band: 'healthy' }],
      findings: [{ label: 'thinning turf', hedged: true }],
      ties: [
        { t: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' },
        { t: 'photo', kind: 'insects', label: 'chinch bug activity', sure: false, product: null },
      ],
      recurring: true,
      nextVisit: true,
      watch: ['weeds'],
    };
    const count = (text) => splitSentences(text).length;
    const TIE1 = 'Today’s photos showed gray leaf spot in one area. Today’s visit included a fungicide treatment.';
    const TIE2 = 'Today’s photos showed what may be chinch bug activity in one area. We will check it by hand at the next visit.';

    test('nine sentences before the cap, at most six after, in every combination of the optional parts', () => {
      for (const recurring of [true, false]) {
        for (const nextVisit of [true, false]) {
          for (const withAreas of [true, false]) {
            const slots = { ...full, recurring, nextVisit, areas: withAreas ? full.areas : [] };
            expect(count(summary.render(slots))).toBeLessThanOrEqual(summary.MAX_SENTENCES);
          }
        }
      }
    });

    test('drop order: the results line, then the next-visit line, then the area read; both ties survive whole at six sentences', () => {
      const text = summary.render(full);
      expect(text).not.toContain('Results from treatments');
      expect(text).not.toContain('At the next visit we will look at');
      expect(text).not.toContain('Our photo read shows');
      expect(text).toContain('In the photos we noticed');
      expect(text).toContain(TIE1);
      expect(text).toContain(TIE2);
      expect(count(text)).toBe(6);
      // Each drop is made only while the paragraph is over the cap: take the finding away (eight sentences) and the
      // area read stays, the next-visit and results lines still go.
      const eight = summary.render({ ...full, findings: [] });
      expect(eight).toContain('Our photo read shows');
      expect(eight).not.toContain('At the next visit we will look at');
      expect(eight).not.toContain('Results from treatments');
      expect(count(eight)).toBe(6);
    });

    test('both ties print whole when the count allows (no area read, no results, no next visit line)', () => {
      const text = summary.render({ ...full, areas: [], recurring: false, nextVisit: false });
      expect(text).toContain(TIE1);
      expect(text).toContain(TIE2);
      expect(count(text)).toBe(6);
    });

    test('a tie is whole or absent: never one sentence of a two-sentence tie', () => {
      for (const slots of [full, { ...full, areas: [] }, { ...full, recurring: false }, { ...full, ties: [full.ties[1], full.ties[0]] }]) {
        const text = summary.render(slots);
        for (const tie of [TIE1, TIE2]) {
          const [first, second] = tie.split('. ').map((x, i) => (i ? x : `${x}.`));
          expect(text.includes(first)).toBe(text.includes(second));
        }
      }
    });

    test('a frozen v4 entry with two long ties reads back exactly (text == render(slots)); nothing was cut after the fact', () => {
      const text = summary.render(full);
      const guard = summary._test.frozenEntryProblem({ v: 4, assessmentId: '77', text, slots: full });
      expect(guard).toBeNull();
      expect(summary._test.frozenEntryProblem({ v: 4, assessmentId: '77', text: `${text} ${TIE2}`, slots: full })).toBe('drift');
    });
  });

  test('a visit with only a tie (nothing else grounded) still composes', () => {
    expect(compose({ applied: [], ties: [tech('fungus', 'fungicide')] }).ok).toBe(true);
  });
});

describe('ties in the facts', () => {
  test('a malformed or hand-edited tie never reaches the slots', () => {
    const facts = summary.normalizeFacts({
      ties: [
        photo('fungus', 'weed pressure', 'fungicide'),
        photo('fungus', 'gray leaf spot', 'herbicide'),
        tech('chinch', 'fungicide'),
        { source: 'oracle', kind: 'fungus' },
        null,
        photo('fungus', 'gray leaf spot', 'fungicide'),
      ],
    });
    expect(facts.ties).toEqual([photo('fungus', 'gray leaf spot', 'fungicide')]);
  });

  test('normalization is idempotent, and a visit with no tie normalizes (and hashes) exactly as before', () => {
    const once = summary.normalizeFacts({ applied: [{ name: 'x', kind: 'fungicide' }], ties: [photo('fungus', 'gray leaf spot', 'fungicide')] });
    expect(summary.normalizeFacts(once)).toEqual(once);
    expect(summary.normalizeFacts({ applied: [{ name: 'x', kind: 'fungicide' }] })).not.toHaveProperty('ties');
    expect(summary.normalizeFacts({ applied: [{ name: 'x', kind: 'fungicide' }], ties: [] })).not.toHaveProperty('ties');
  });

  test('a render never prints a tie id outside the tables', () => {
    const text = summary.render({
      season: 'fall',
      applied: [],
      ties: [
        { t: 'photo', kind: 'fungus', label: 'chinch bugs', sure: true, product: 'fungicide' },
        { t: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'rodenticide' },
        { t: 'photo', kind: 'weeds', label: 'gray leaf spot', sure: true, product: 'herbicide' },
        { t: 'tech', kind: 'toString' },
        { t: 'oracle', kind: 'fungus' },
        '__proto__',
      ],
    });
    expect(text).toBe('');
  });
});

describe('the closed tie tables', () => {
  const S = summary.SENTENCE;
  const sentences = () => [
    ...Object.values(summary.TIE_PRODUCT_PHRASES).flatMap((product) => [S.tieSure('gray leaf spot', product), S.tieHedged('weed pressure', product)]),
    S.tieCheck('chinch bug activity'),
    ...Object.values(summary.TECH_FOUND_PHRASES).map((found) => S.tieTech(found)),
  ];

  test('every sentence passes the customer-copy and result-timing screens, with no digit, product name or promise', () => {
    for (const sentence of sentences()) {
      expect(customerCopyViolations(sentence)).toEqual([]);
      expect(lawnResultTimingViolation(sentence, { carePlanExempt: false })).toBe(false);
      expect(sentence).not.toMatch(/\d/);
      expect(sentence).not.toMatch(/\b(cure[sd]?|heal(ed|s)?|eliminat\w*|guarantee\w*|safe\w*)\b/i);
    }
  });

  test('a PHOTO tie never says that spot or that area was treated (no place is recorded for a spot row); the technician\'s own find does', () => {
    for (const kind of ['fungus', 'weeds', 'insects', 'drought']) {
      const label = { fungus: 'gray leaf spot', weeds: 'weed pressure', insects: 'chinch bug activity', drought: 'drought stress' }[kind];
      const product = { fungus: 'fungicide', weeds: 'herbicide', insects: 'insecticide', drought: 'wetting_agent' }[kind];
      for (const sure of [true, false]) {
        const text = summary.render(summary.buildSlots({ applied: [], ties: [photo(kind, label, product, sure)] }));
        expect(text).not.toMatch(/\b(that|the) (spot|area)\b.*\b(treat|applied)/i);
        expect(text).not.toMatch(/treated (that|the) (spot|area)/i);
        expect(text).toMatch(/today’s visit included/i);
      }
    }
    expect(summary.render(summary.buildSlots({ applied: [], ties: [tech('chinch', 'insecticide')] }))).toContain('treated that spot today');
  });

  test('the longest paragraph any valid slots can render fits the cap and the screens', () => {
    const slots = {
      season: 'winter',
      applied: ['combo_insecticide', 'supplement', 'herbicide', 'fungicide'],
      areas: [{ key: 'weed_pressure', band: 'needs_attention' }, { key: 'coverage', band: 'healthy' }, { key: 'color_vigor', band: 'needs_attention' }, { key: 'damage_disease_signals', band: 'needs_attention' }],
      findings: [{ label: 'color and nutrient stress', hedged: true }, { label: 'a lawn condition we are monitoring', hedged: true }, { label: 'general lawn stress', hedged: true }],
      ties: [
        { t: 'photo', kind: 'fungus', label: 'large patch (fungal) activity', sure: false, product: 'fungicide' },
        { t: 'photo', kind: 'insects', label: 'caterpillar activity', sure: false, product: 'insecticide' },
      ],
      recurring: true,
      nextVisit: true,
      watch: ['weeds', 'thin', 'color'],
    };
    const text = summary.render(slots);
    expect(splitSentences(text).length).toBeLessThanOrEqual(summary.MAX_SENTENCES);
    expect(text.length).toBeLessThanOrEqual(summary.MAX_TEXT_CHARS);
    expect(summary._test.textProblem(text)).toBeNull();
  });
});

describe('freeze: version 4 with the tie, version 3 as before', () => {
  function fakeKnex(initial = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initial)) };
    const knex = () => {
      const q = { guardKey: null };
      q.where = () => q;
      q.whereRaw = (_sql, bindings) => { q.guardKey = Array.isArray(bindings) ? bindings[0] : null; return q; };
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        const patch = JSON.parse(raw.bindings[0]);
        if ((state.notes.lawnVisitSummary || {})[q.guardKey]) return 0;
        state.notes.lawnVisitSummary = { ...(state.notes.lawnVisitSummary || {}), ...patch };
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }
  const FACTS = { season: 'fall', applied: [{ name: 'x', kind: 'fungicide' }], areas: [], findings: [], ties: [photo('fungus', 'gray leaf spot', 'fungicide')] };
  const freeze = (knex, args = {}) => summary.createAndFreezeVisitSummary({
    serviceRecordId: 's1', assessmentId: 77, getStructuredNotes: async () => (await knex('x').first()).structured_notes, gatherInputs: async () => FACTS, knex, ...args,
  });

  test('a v4 entry carries the tie facts in its slots, reads back, and keys the PDF by its text', async () => {
    const { knex, state } = fakeKnex();
    expect((await freeze(knex, { version: summary.FREEZE_VERSION_TIES })).status).toBe('frozen');
    const entry = state.notes.lawnVisitSummary['77'];
    expect(entry.v).toBe(4);
    expect(entry.slots.ties).toEqual([{ t: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' }]);
    expect(summary.readFrozenVisitSummary(state.notes, 77)).toContain('Today’s visit included a fungicide treatment.');
    const withTie = summary.visitSummarySignature(state.notes, 77);
    expect(withTie).toMatch(/^:tp=[0-9a-f]{8}$/);
    const plain = fakeKnex();
    await freeze(plain.knex, { version: summary.FREEZE_VERSION_TIES, gatherInputs: async () => ({ ...FACTS, ties: [] }) });
    expect(summary.visitSummarySignature(plain.state.notes, 77)).not.toBe(withTie);
  });

  test('the default version is still 3 (gate off writes the entry it always did)', async () => {
    const { knex, state } = fakeKnex();
    await freeze(knex, { gatherInputs: async () => ({ ...FACTS, ties: undefined }) });
    expect(state.notes.lawnVisitSummary['77'].v).toBe(3);
    expect(state.notes.lawnVisitSummary['77'].slots).not.toHaveProperty('ties');
  });

  test('a v3 entry renders unchanged whatever gate is set; a v4 entry renders the same with the gate off', async () => {
    const v3 = fakeKnex();
    await freeze(v3.knex, { gatherInputs: async () => ({ ...FACTS, ties: undefined }) });
    const v4 = fakeKnex();
    await freeze(v4.knex, { version: summary.FREEZE_VERSION_TIES });
    const reads = [];
    for (const gate of [undefined, 'true']) {
      if (gate === undefined) delete process.env.GATE_LAWN_REPORT_FACTS; else process.env.GATE_LAWN_REPORT_FACTS = gate;
      reads.push([summary.readFrozenVisitSummary(v3.state.notes, 77), summary.readFrozenVisitSummary(v4.state.notes, 77)]);
    }
    delete process.env.GATE_LAWN_REPORT_FACTS;
    expect(reads[0]).toEqual(reads[1]);
    expect(reads[0][0]).toBe('Today we applied disease protection, which fits the fall season.');
    expect(reads[0][1]).toContain('Today’s photos showed gray leaf spot in one area.');
  });

  test('a version this code does not know prints nothing', async () => {
    const { knex, state } = fakeKnex();
    await freeze(knex, { version: summary.FREEZE_VERSION_TIES });
    const notes = JSON.parse(JSON.stringify(state.notes));
    notes.lawnVisitSummary['77'].v = 5;
    expect(summary.readFrozenVisitSummary(notes, 77)).toBeNull();
    notes.lawnVisitSummary['77'].v = 2;
    expect(summary.readFrozenVisitSummary(notes, 77)).toBeNull();
  });

  test('an edited v4 tie slot (a promise, another product, another label) prints nothing', async () => {
    const { knex, state } = fakeKnex();
    await freeze(knex, { version: summary.FREEZE_VERSION_TIES });
    for (const edit of [
      (e) => { e.slots.ties[0].product = 'insecticide'; },
      (e) => { e.slots.ties[0].label = 'weed pressure'; },
      (e) => { e.slots.ties[0].sure = false; },
      (e) => { e.text = e.text.replace('visit included', 'visit will include'); },
    ]) {
      const notes = JSON.parse(JSON.stringify(state.notes));
      edit(notes.lawnVisitSummary['77']);
      expect(summary.readFrozenVisitSummary(notes, 77)).toBeNull();
    }
  });
});

describe('gatherVisitSummaryFacts hands the frozen ties through', () => {
  const DATA = {
    lawnAssessment: { assessmentId: 77 },
    reportV2: { treatment: { products: [] }, diagnosis: [], insights: [] },
  };
  const knex = () => {
    const q = {};
    q.where = () => q;
    q.first = async () => ({ id: 77, customer_id: 'c1', confirmed_by_tech: true });
    return q;
  };

  test('the ties the caller passes are the ties in the facts; none passed means none', async () => {
    const record = { service_date: '2026-10-08' };
    const withTies = await gatherVisitSummaryFacts({ record, data: DATA, ties: [photo('fungus', 'gray leaf spot', 'fungicide')], knex });
    expect(withTies.ties).toEqual([photo('fungus', 'gray leaf spot', 'fungicide')]);
    const without = await gatherVisitSummaryFacts({ record, data: DATA, knex });
    expect(without).not.toHaveProperty('ties');
  });
});
