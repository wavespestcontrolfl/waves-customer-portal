/**
 * LABEL FACTS (owner ruling 2026-09-30) — GATE_SMS_REAL_ANSWERS only.
 * The texting agent may quote a label's rainfast / re-entry time, but only
 * from the label of a product applied at the customer's last visit, and only
 * when that exact number+unit is in the draft's LABEL FACTS section.
 * Gate off: facts block + prompts byte-identical to before (same hashes as
 * sms-company-facts.test.js, captured from origin/main 8781b3f1c5).
 */
// The service identity lane answers "no job named" and call-booking-catalog is
// empty: these tests exercise the LABEL FACTS plumbing, not the visit pick.
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return {
    ...actual,
    dispatchWithFallback: (policy, payload, options) => (payload?.laneId === 'sms_service_identity'
      ? Promise.resolve({ ok: true, json: { about: 'none', visit: null, service: null } })
      : actual.dispatchWithFallback(policy, payload, options)),
  };
});
const mockFetchLabelFacts = jest.fn();
jest.mock('../services/sms-label-facts', () => ({
  ...jest.requireActual('../services/sms-label-facts'),
  fetchLabelFacts: (...a) => mockFetchLabelFacts(...a),
}));
const crypto = require('crypto');
const {
  buildSystemPrompt,
  buildSystemPromptWithProfile,
  buildFactsBlock,
  currentPromptVersion,
  hasBannedCustomerCopy,
  validateComplianceCopy,
  PROMPT_VERSION,
  REAL_ANSWERS_PROMPT_VERSION,
  REAL_ANSWERS_HANDOFF_CATEGORIES,
} = require('../services/sms-shadow-drafter');
const labelFactsLib = jest.requireActual('../services/sms-label-facts');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const CHEM = 'GATE_SMS_AGENT_CHEMICAL_MEDICAL';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const context = { summary: 'Test customer', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19', window: '8-10am' }] };
const NOW = new Date('2026-06-10T15:00:00Z');

const labelFacts = (products) => ({ serviceDate: '2026-06-05', products, unverifiedCount: 0 });
const product = (over = {}) => ({
  phrase: 'an insecticide', rainfastMinutes: null, reiHours: 0,
  reentrySummary: 'Keep people and pets off treated areas until dry.', reentryText: null,
  labelVerifiedAt: '2026-05-28', ...over,
});

afterEach(() => {
  delete process.env[GATE];
  for (const c of REAL_ANSWERS_HANDOFF_CATEGORIES) delete process.env[c.gate];
});

describe('gate off — byte-identical', () => {
  test('facts block and prompts match the pre-change hashes, even when label facts are passed in', () => {
    delete process.env[GATE];
    const facts = buildFactsBlock(context, { now: NOW });
    expect(sha(facts)).toBe('22a25c57a1ad7b96988e31271d69857da001734822b6cceb7f03097f12709034');
    const withLabel = buildFactsBlock(context, { now: NOW, labelFacts: labelFacts([product({ rainfastMinutes: 180 })]) });
    expect(withLabel).toBe(facts);
    expect(withLabel).not.toContain('LABEL FACTS');
    expect(sha(buildSystemPrompt())).toBe('8fc58d9bcd7cdf437f7f6d49290a01c375c696f31f346a2db121ed59e98da0f3');
    expect(sha(buildSystemPromptWithProfile('Warm and brief.').system)).toBe('7e35da9035dd011a3f0b6ab8596b9876926956fbaf1ca05139d59f4ef8248a9b');
    expect(buildSystemPrompt()).not.toContain('LABEL FACTS');
    expect(currentPromptVersion()).toBe(PROMPT_VERSION);
  });

  test('compliance guard is a no-op gate off and the numeric ban is unchanged', () => {
    delete process.env[GATE];
    expect(validateComplianceCopy({ reply: 'It dries in 2 hours.', factsBlock: 'LABEL FACTS (x):\n- a: rainfast after 3 hours\n' })).toEqual({ ok: true, violations: [] });
    expect(hasBannedCustomerCopy('It dries in 2 hours.')).toBe(true);
    // rainfast was never on the older lists; only the gate-on guard bans an ungrounded one
    expect(hasBannedCustomerCopy('It is rainfast after 3 hours.')).toBe(false);
    expect(hasBannedCustomerCopy('It is rainfast after 3 hours.', { rainTimeGuard: true })).toBe(true);
  });
});

describe('gate on — section rendering', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });
  const section = (products) => {
    const facts = buildFactsBlock(context, { now: NOW, labelFacts: labelFacts(products) });
    return { facts, text: labelFactsLib.labelFactsSectionFrom(facts) };
  };

  test('rainfast present: header names the visit date, line uses the type phrase, hours for whole hours', () => {
    const { facts, text } = section([product({ rainfastMinutes: 180 })]);
    expect(text.split('\n')[0]).toBe('LABEL FACTS (from the labels of products applied at the last visit on Friday, Jun 5):');
    expect(text).toContain('- an insecticide: rainfast after 3 hours; re-entry: Keep people and pets off treated areas until dry');
    expect(facts.indexOf('COMPANY FACTS')).toBeLessThan(facts.indexOf('LABEL FACTS'));
    expect(facts.indexOf('LABEL FACTS')).toBeLessThan(facts.indexOf('BILLING:'));
  });

  test('rainfast absent: only the re-entry clause; non-hour minutes stay in minutes', () => {
    expect(section([product()]).text).toContain('- an insecticide: re-entry: Keep people and pets off treated areas until dry');
    expect(section([product()]).text).not.toContain('rainfast');
    expect(section([product({ rainfastMinutes: 90 })]).text).toContain('rainfast after 90 minutes');
    expect(section([product({ rainfastMinutes: 60 })]).text).toContain('rainfast after 1 hour;');
  });

  test('rei_hours = 0 with no summary reads "until dry"; rei_hours > 0 states the label hours', () => {
    expect(section([product({ reentrySummary: null })]).text).toContain('re-entry: keep people and pets off treated areas until dry');
    expect(section([product({ reentrySummary: null, reiHours: 4 })]).text).toContain('re-entry: keep people and pets off treated areas for 4 hours');
    // the catalog's generic placeholder is not a re-entry statement
    expect(section([product({ reentrySummary: 'Follow the product label and technician service report before re-entering treated areas.' })]).text)
      .toContain('until dry');
  });

  test('a summary that would itself be banned copy (a "safe" claim) is replaced by the derived wording', () => {
    const { text } = section([product({ reentrySummary: 'Safe for pets once dry.' })]);
    expect(text).toContain('re-entry: keep people and pets off treated areas until dry');
    expect(text).not.toMatch(/safe/i);
  });

  test('never a brand name: only the neutral type phrase reaches the section', () => {
    const { text } = section([product({ phrase: 'an insect growth regulator', rainfastMinutes: 60 })]);
    expect(text).toContain('an insect growth regulator');
    expect(text).not.toMatch(/talak|taurus|gentrol|speedzone|bifen/i);
  });

  test('identical lines collapse, no timing at all renders no section', () => {
    const { text } = section([product({ rainfastMinutes: 180 }), product({ rainfastMinutes: 180 })]);
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(buildFactsBlock(context, { now: NOW, labelFacts: labelFacts([product({ reentrySummary: null, reiHours: null })]) })).not.toContain('LABEL FACTS');
    expect(buildFactsBlock(context, { now: NOW })).not.toContain('LABEL FACTS');
    expect(buildFactsBlock(context, { now: NOW, labelFacts: null })).not.toContain('LABEL FACTS');
  });
});

describe('label row selection (mock knex)', () => {
  function fakeConn({ visits, rows }) {
    const calls = [];
    const conn = (table) => {
      const q = {
        table, ops: [],
        where(...a) { this.ops.push(['where', ...a]); return this; },
        whereIn(...a) { this.ops.push(['whereIn', ...a]); return this; },
        whereRaw(...a) { this.ops.push(['whereRaw', ...a]); return this; },
        leftJoin(...a) { this.ops.push(['leftJoin', ...a]); return this; },
        orderBy(...a) { this.ops.push(['orderBy', ...a]); return this; },
        limit(n) { this.ops.push(['limit', n]); return this; },
        select(...a) { this.ops.push(['select', ...a]); calls.push(this); return Promise.resolve(table === 'service_records' ? visits : rows); },
      };
      return q;
    };
    conn.calls = calls;
    return conn;
  }
  const row = (over) => ({
    id: 1, product_name: 'Some Product', active_ingredient: 'bifenthrin', product_category: 'insecticide',
    catalog_category: 'insecticide', catalog_product_type: null,
    rainfast_minutes: 180, rei_hours: 0, reentry_summary: 'Keep people and pets off treated areas until dry.', reentry_text: null,
    label_verified_at: '2026-05-28', ...over,
  });

  test('most recent performed visit only; joins service_products to products_catalog; unverified and adjuvants are omitted and counted', async () => {
    const conn = fakeConn({
      visits: [
        { id: 'r2', service_date: '2026-06-05' },
        { id: 'r3', service_date: '2026-06-05' },
        { id: 'r1', service_date: '2026-05-01' }, // an older visit is never mixed in
      ],
      rows: [
        row({ id: 1 }),
        row({ id: 2, product_name: 'Unverified Thing', label_verified_at: null, rainfast_minutes: 60 }),
        row({ id: 3, product_name: 'LESCO 90/10 Nonionic Surfactant', active_ingredient: 'nonionic surfactant', product_category: 'adjuvant', catalog_category: 'adjuvant' }),
        row({ id: 4, product_name: 'Buffer', active_ingredient: 'acidifier', product_category: 'water conditioner', catalog_category: 'water conditioner' }),
      ],
    });
    const out = await labelFactsLib.readLastVisitLabelFacts({ customerId: 'c1', conn });
    expect(out.serviceDate).toBe('2026-06-05');
    expect(out.unverifiedCount).toBe(1);
    expect(out.products).toHaveLength(1);
    expect(out.products[0]).toMatchObject({ phrase: 'an insecticide', rainfastMinutes: 180, reiHours: 0 });
    // the rows read are those of the newest date only
    const productQuery = conn.calls.find((q) => q.table === 'service_products as sp');
    expect(productQuery.ops).toContainEqual(['whereIn', 'sp.service_record_id', ['r2', 'r3']]);
    expect(productQuery.ops.some((o) => o[0] === 'leftJoin' && o[1] === 'products_catalog as pc')).toBe(true);
    // performed-visit filter (completed, customer-visible, not a no-show)
    const visitQuery = conn.calls.find((q) => q.table === 'service_records');
    expect(visitQuery.ops.some((o) => o[0] === 'where' && o[1] === 'service_records.status' && o[2] === 'completed')).toBe(true);
  });

  test('no visit, no customer, or nothing verified -> null', async () => {
    expect(await labelFactsLib.readLastVisitLabelFacts({ customerId: null })).toBeNull();
    expect(await labelFactsLib.readLastVisitLabelFacts({ customerId: 'c1', conn: fakeConn({ visits: [], rows: [] }) })).toBeNull();
    expect(await labelFactsLib.readLastVisitLabelFacts({
      customerId: 'c1', conn: fakeConn({ visits: [{ id: 'r', service_date: '2026-06-05' }], rows: [row({ label_verified_at: null })] }),
    })).toBeNull();
  });

  test('fetchLabelFacts is fail-safe: a DB error resolves to null', async () => {
    const boom = () => { throw new Error('db down'); };
    expect(await labelFactsLib.fetchLabelFacts({ customerId: 'c1', conn: boom })).toBeNull();
  });
});

describe('compliance grounding', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });
  const factsWith = (products) => buildFactsBlock(context, { now: NOW, labelFacts: labelFacts(products) });
  const facts = () => factsWith([product({ rainfastMinutes: 180 }), product({ phrase: 'a weed control', reentrySummary: null, reiHours: 4 })]);
  const check = (reply, factsBlock = facts()) => validateComplianceCopy({ reply, factsBlock });

  test('allows the grounded rainfast time, in digits, about rain', () => {
    expect(check('It is rainfast after 3 hours, so rain after that will not wash it off.').ok).toBe(true);
    expect(check('Once 3 hours have passed, rain will not wash it off.').ok).toBe(true);
  });

  test('allows the grounded re-entry time as re-entry, and "until dry"', () => {
    expect(check('Please keep the dogs off the treated areas for 4 hours.').ok).toBe(true);
    expect(check('Keep people and pets off treated areas until dry.').ok).toBe(true);
  });

  test('rejects an ungrounded time', () => {
    expect(check('It will be dry in 2 hours.').ok).toBe(false);
    expect(check('You can go back out after 30 minutes.').ok).toBe(false);
    expect(check('It is rainfast after 2 hours.').ok).toBe(false); // number not in the section
    expect(check('It is rainfast after 3 days.').ok).toBe(false); // unit not in the section
  });

  test('rejects a grounded number used as the WRONG kind of time', () => {
    // 3 hours is the rainfast time only, never a re-entry / drying time
    expect(check('The dog can go back out after 3 hours.').ok).toBe(false);
    expect(check('It dries in 3 hours.').ok).toBe(false);
    // 4 hours is the re-entry time only, never a rainfast time
    expect(check('It is rainfast after 4 hours.').ok).toBe(false);
  });

  test('a spelled-out figure never grounds', () => {
    expect(check('It is rainfast after three hours.').ok).toBe(false);
  });

  test('no LABEL FACTS section in the facts -> every numeric time stays banned', () => {
    const bare = buildFactsBlock(context, { now: NOW });
    expect(check('It is rainfast after 3 hours.', bare).ok).toBe(false);
    expect(check('Keep pets off for 4 hours.', bare).ok).toBe(false);
  });

  test('safety claims stay banned regardless of grounding', () => {
    for (const reply of [
      'It is pet-safe.',
      'Totally non-toxic, and rainfast after 3 hours.',
      'It is safe for kids after 4 hours.',
      'EPA-approved and rainfast after 3 hours.',
      'The treatment is safe once it is rainfast after 3 hours.',
      'Safe to walk on after 4 hours.',
    ]) expect(check(reply).ok).toBe(false);
  });

  test('a mixed reply is held when ANY time is ungrounded', () => {
    expect(check('Rainfast after 3 hours, and dry in 2 hours.').ok).toBe(false);
  });

  test('a grounded time in a violation message: the revise instruction names LABEL FACTS', () => {
    const bad = check('It dries in 2 hours.');
    expect(bad.violations[0]).toContain('LABEL FACTS');
    expect(check('It dries in 2 hours.', buildFactsBlock(context, { now: NOW })).violations[0]).not.toContain('LABEL FACTS');
  });

  test('ranges and decimals: grounded only on the exact expression', () => {
    const f = factsWith([product({ rainfastMinutes: null, reentrySummary: null, reiHours: 4 })]);
    expect(labelFactsLib.groundedTimeKeys(labelFactsLib.labelFactsSectionFrom(f)).reentry.has('4h')).toBe(true);
    expect(check('Keep pets off for 4 hrs.', f).ok).toBe(true);
    expect(check('Keep pets off for 1-4 hours.', f).ok).toBe(false);
  });
});

describe('prompt rules and hand-off narrowing', () => {
  test('gate-on system prompt carries the LABEL FACTS rules and lists the section as a fact source', () => {
    process.env[GATE] = 'true';
    const { system } = buildSystemPromptWithProfile();
    expect(system).toContain('LABEL FACTS (product timing from the label):');
    expect(system).toContain('COMPANY FACTS, LABEL FACTS, the thread');
    expect(system).toContain('never a brand name');
    expect(system).toMatch(/Never call a treatment safe/);
  });

  test('chemical/medical gate OFF: a timing question is carved out, symptoms/exposure stay held, gate list unchanged', () => {
    process.env[GATE] = 'true';
    const { system } = buildSystemPromptWithProfile();
    expect(system).toContain('HELD FOR A PERSON: complaints, billing disputes, chemical/medical concerns, legal threats');
    expect(system).toContain('is NOT a chemical/medical concern when the LABEL FACTS section is in the facts');
    expect(system).toMatch(/Symptoms, illness, exposure, or anyone or any pet that touched, ate, or breathed something still HOLD/);
  });

  test('chemical/medical gate ON: no carve-out bullet is added (the gate handles it)', () => {
    process.env[GATE] = 'true';
    process.env[CHEM] = 'true';
    const { system } = buildSystemPromptWithProfile();
    expect(system).not.toContain('is NOT a chemical/medical concern');
  });

  test('prompt version: _cfl, prefix kept, fits the column with all four tags', () => {
    process.env[GATE] = 'true';
    expect(REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers_cfl');
    expect(currentPromptVersion()).toBe('house_voice_v12_real_answers_cfl');
    for (const c of REAL_ANSWERS_HANDOFF_CATEGORIES) process.env[c.gate] = 'true';
    const all = currentPromptVersion();
    expect(all).toBe('house_voice_v12_real_answers_cfl+bclm');
    expect(all.length).toBeLessThanOrEqual(40);
  });
});

describe('generateGroundedDraft — LABEL FACTS reach the facts block and the compliance guard', () => {
  const { generateGroundedDraft } = require('../services/sms-shadow-drafter');
  const makeClient = (scripted) => {
    const queue = [...scripted];
    const calls = [];
    return {
      calls,
      messages: { create: (args) => { calls.push(args); return Promise.resolve({ content: [{ text: JSON.stringify(queue.shift()) }] }); } },
    };
  };
  const draft = (reply) => ({ reply, intended_actions: [], missing_info: null, offered_times: [] });
  const args = (client) => ({
    client,
    context: { summary: 'Test customer', customer: { id: 'cust-1' }, upcomingServices: [] },
    inboundMessage: 'Will rain wash it off?',
    intent: { intent: 'general_customer_sms_needs_review' },
    schedulingIntent: false,
  });
  beforeEach(() => { process.env[GATE] = 'true'; mockFetchLabelFacts.mockReset(); });

  test('fetched label facts render into the shared facts block; a grounded rainfast time converges through the guard', async () => {
    mockFetchLabelFacts.mockResolvedValue(labelFacts([product({ rainfastMinutes: 180 })]));
    const client = makeClient([draft('Rain will not wash it off after 3 hours.'), { supported: true, violations: [] }]);
    const r = await generateGroundedDraft(args(client));
    expect(mockFetchLabelFacts).toHaveBeenCalledWith({ customerId: 'cust-1' });
    expect(r.factsBlock).toContain('- an insecticide: rainfast after 3 hours; re-entry:');
    expect(r.promptVersion).toBe('house_voice_v12_real_answers_cfl');
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
  });

  test('an ungrounded time never converges (guard feeds the revise loop, verifier never asked)', async () => {
    mockFetchLabelFacts.mockResolvedValue(labelFacts([product({ rainfastMinutes: 180 })]));
    const bad = draft('It will be dry in 2 hours.');
    const client = makeClient([bad, bad, bad]);
    const r = await generateGroundedDraft(args(client));
    expect(r.converged).toBe(false);
    expect(client.calls).toHaveLength(3); // three generations, no verifier call
  });

  test('the same rainfast reply with no label facts fetched is held', async () => {
    mockFetchLabelFacts.mockResolvedValue(null);
    const bad = draft('Rain will not wash it off after 3 hours.');
    const client = makeClient([bad, bad, bad]);
    const r = await generateGroundedDraft(args(client));
    expect(r.factsBlock).not.toContain('LABEL FACTS');
    expect(r.converged).toBe(false);
  });

  test('gate off: the label-facts fetch never runs', async () => {
    delete process.env[GATE];
    mockFetchLabelFacts.mockResolvedValue(labelFacts([product({ rainfastMinutes: 180 })]));
    const client = makeClient([draft('Sounds good.'), { supported: true, violations: [] }]);
    const r = await generateGroundedDraft(args(client));
    expect(mockFetchLabelFacts).not.toHaveBeenCalled();
    expect(r.factsBlock).not.toContain('LABEL FACTS');
  });
});
