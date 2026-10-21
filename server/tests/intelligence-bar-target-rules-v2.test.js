/**
 * GATE_IB_TARGET_RULES_V2 (owner rulings 2026-10-12 decision 3 and 2026-10-20):
 *  1. an owner-direct customer edit keeps its card when the message did not name
 *     the customer and the customer is not on screen;
 *  2. a same-name lookup lists up to 25 customers (name, city, last visit);
 *  3. one request may make 5 direct edits with the same tool.
 * Gate off = today's behavior, checked beside each rule.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-dedupe', () => ({ duplicatePairEligibility: jest.fn(async () => ({ eligible: false })) }));
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');
const { ibTargetRulesV2Live } = require('../config/feature-gates');

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ON = 'GATE_IB_TARGET_RULES_V2';
afterEach(() => { delete process.env[ON]; });

describe('the gate', () => {
  test('is dark: only the exact string true turns it on', () => {
    expect(ibTargetRulesV2Live()).toBe(false);
    for (const value of ['1', 'on', 'TRUE', 'yes', '']) { process.env[ON] = value; expect(ibTargetRulesV2Live()).toBe(false); }
    process.env[ON] = 'true';
    expect(ibTargetRulesV2Live()).toBe(true);
  });
});

describe('rule 1: a card when the customer is neither named nor on screen', () => {
  const NAMED = id(1), SCREEN = id(2), FOUND = id(3), OTHER_PAGE = id(4);
  const phoneEdit = customer_id => ({ customer_id, updates: { phone: '941-555-0100' } });
  // A task context as owner-direct leaves it: the name typed in this message resolved to NAMED.
  const context = (extra = {}) => ({ targets: [], typedCustomerIds: [NAMED], page: { ids: { customer_id: SCREEN } }, ...extra });
  const run = (tool, input, preview = null, ctx = context()) => OwnerDirect.executesWithoutCard(tool, input, preview, null, OwnerDirect.targetGrounding(ctx));

  test('gate off: nothing changes, whatever the message named', () => {
    expect(OwnerDirect.targetGrounding(context())).toBeNull();
    expect(run('update_customer', phoneEdit(FOUND))).toBe(true);
    expect(OwnerDirect.mayExecuteWithoutCard('update_customer', phoneEdit(FOUND))).toBe(true);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env[ON] = 'true'; });

    test('named / on-screen / model-found matrix for the four customer_id tools', () => {
      const inputs = {
        update_customer: customer_id => phoneEdit(customer_id),
        update_customer_property: customer_id => ({ customer_id, property_id: id(50), relationship: 'rental' }),
        set_primary_property: customer_id => ({ customer_id, property_id: id(50) }),
        update_property_access: customer_id => ({ customer_id, parking_notes: 'Park on the street' }),
      };
      for (const [tool, make] of Object.entries(inputs)) {
        expect([tool, 'named', run(tool, make(NAMED))]).toEqual([tool, 'named', true]);
        expect([tool, 'on screen', run(tool, make(SCREEN))]).toEqual([tool, 'on screen', true]);
        expect([tool, 'model-found', run(tool, make(FOUND))]).toEqual([tool, 'model-found', false]);
        expect([tool, 'other page record', run(tool, make(OTHER_PAGE))]).toEqual([tool, 'other page record', false]);
      }
    });

    test('a case-different id still matches; a missing id and a missing context card', () => {
      expect(run('update_customer', phoneEdit(NAMED.toUpperCase()))).toBe(true);
      expect(run('update_customer', { updates: { phone: '941-555-0100' } })).toBe(false);
      // The decision has no grounding to read: fail closed.
      expect(OwnerDirect.executesWithoutCard('update_customer', phoneEdit(NAMED), null, null, null)).toBe(false);
      expect(OwnerDirect.executesWithoutCard('update_customer', phoneEdit(NAMED))).toBe(false);
    });

    test('the customer a resolved target, the viewed customer record or the operator selection names counts', () => {
      const target = { customer_id: FOUND, label: 'Pat Example', provenance: 'operator_selection' };
      expect(run('update_customer', phoneEdit(FOUND), null, context({ targets: [target], target }))).toBe(true);
      expect(run('update_customer', phoneEdit(FOUND), null, { targets: [], page: { ids: {}, customer: { customer_id: FOUND, label: 'Pat Example' } } })).toBe(true);
    });

    test('the page decides the on-screen customer, not the input: a stale page record names nobody', () => {
      expect(run('update_customer', phoneEdit(SCREEN), null, { targets: [], page: { ids: {} } })).toBe(false);
    });

    test('an address edit is carded for a named customer too (not weakened)', () => {
      expect(run('update_customer', { customer_id: NAMED, updates: { city: 'Venice' } })).toBe(false);
      expect(run('update_customer', { customer_id: NAMED, updates: { address_line1: '1 Example Way' } })).toBe(false);
    });

    test('reschedule_appointment reads the pinned appointment owner', () => {
      const pin = customer_id => ({ pinned_appointment: { id: id(60), customer_id, visit_id: null } });
      expect(run('reschedule_appointment', { appointment_id: id(60), new_date: '2026-11-03' }, pin(NAMED))).toBe(true);
      expect(run('reschedule_appointment', { appointment_id: id(60), new_date: '2026-11-03' }, pin(SCREEN))).toBe(true);
      expect(run('reschedule_appointment', { appointment_id: id(60), new_date: '2026-11-03' }, pin(FOUND))).toBe(false);
      expect(run('reschedule_appointment', { appointment_id: id(60), new_date: '2026-11-03' }, { pinned_appointment: { id: id(60), visit_id: null } })).toBe(false);
    });

    test('assign_technician reads the stop customer id: a same-name customer is not the named one', () => {
      const input = { service_ids: [id(70)], technician_name: 'Synthetic Tech' };
      const preview = customer_id => ({ would_assign_to: 'Synthetic Tech', would_assign_to_id: id(80),
        stops: [{ id: id(70), customer: 'Pat Example', ...(customer_id ? { customer_id } : {}) }] });
      // Two customers named Pat Example: NAMED is the one the owner named, TWIN shares the name.
      const TWIN = id(5);
      const ctx = context({ targets: [{ customer_id: NAMED, label: 'Pat Example' }], page: { ids: {}, customer: { customer_id: SCREEN, label: 'Sam Screen' } } });
      expect(run('assign_technician', input, preview(NAMED), ctx)).toBe(true);
      expect(run('assign_technician', input, preview(SCREEN), ctx)).toBe(true);
      expect(run('assign_technician', input, preview(TWIN), ctx)).toBe(false);
      expect(run('assign_technician', input, preview(FOUND), ctx)).toBe(false);
      // No customer id in the preview (the name alone proves nothing): card.
      expect(run('assign_technician', input, preview(null), ctx)).toBe(false);
    });

    test('tools that edit no customer are not subject to the rule', () => {
      const lead = { lead_id: id(90), new_status: 'contacted' };
      expect(run('update_lead_status', lead)).toBe(true);
      expect(run('create_customer', { first_name: 'New', last_name: 'Person' })).toBe(true);
      expect(run('create_restock_request', {})).toBe(true);
      expect(run('toggle_estimate_v2_view', {})).toBe(true);
    });

    test('a carded-anyway call never counts toward the direct cap', () => {
      const grounding = OwnerDirect.targetGrounding(context());
      const found = { name: 'update_customer', input: phoneEdit(FOUND) };
      const named = { name: 'update_customer', input: phoneEdit(NAMED) };
      expect(OwnerDirect.mayExecuteWithoutCard('update_customer', found.input, null, grounding)).toBe(false);
      expect(OwnerDirect.messageDirectPlan([found, found, found, found, found, found, named], () => true, null, grounding).get('update_customer')).toBe(1);
    });

    test('the untrusted-read flag still wins', () => {
      expect(OwnerDirect.executesWithoutCard('update_customer', phoneEdit(NAMED), null, { untrustedRead: true }, OwnerDirect.targetGrounding(context()))).toBe(false);
    });
  });
});

describe('rule 3: five direct edits per tool', () => {
  const lead = leadId => ({ type: 'tool_use', name: 'update_lead_status', input: { lead_id: leadId, new_status: 'lost' } });
  const capped = (done, calls) => {
    const committed = new Map();
    for (let i = 0; i < done; i++) OwnerDirect.recordDirectCommit(committed, 'update_lead_status');
    return OwnerDirect.cappedTools(committed, OwnerDirect.messageDirectPlan(calls)).has('update_lead_status');
  };

  test('gate off: the 3rd edit is the first refused (today)', () => {
    expect(capped(1, [lead(id(1))])).toBe(false);
    expect(capped(2, [lead(id(1))])).toBe(true);
    expect(OwnerDirect.bulkLimitResult()).toBe(OwnerDirect.BULK_LIMIT_RESULT);
    expect(OwnerDirect.BULK_LIMIT_RESULT.error).toMatch(/^Three or more/);
  });

  test('gate on: the 4th and 5th run direct, the 6th goes to the bulk card', () => {
    process.env[ON] = 'true';
    expect(capped(3, [lead(id(1))])).toBe(false); // the 4th
    expect(capped(4, [lead(id(1))])).toBe(false); // the 5th
    expect(capped(5, [lead(id(1))])).toBe(true); // the 6th
    // One model message planning 5 / 6 calls from zero.
    expect(capped(0, [1, 2, 3, 4, 5].map(n => lead(id(n))))).toBe(false);
    expect(capped(0, [1, 2, 3, 4, 5, 6].map(n => lead(id(n))))).toBe(true);
    // A failed seed read still counts as the cap reached.
    expect(OwnerDirect.cappedTools(new Map([[Symbol.for('x'), true]]), new Map()).size).toBe(0);
  });

  test('gate on: the refusal still points at the bulk tool and says more than 5', () => {
    process.env[ON] = 'true';
    const result = OwnerDirect.bulkLimitResult();
    expect(result).toMatchObject({ code: 'owner_direct_bulk_limit' });
    expect(result.error).toMatch(/^More than 5 edits/);
    expect(result.note).toBe(OwnerDirect.BULK_LIMIT_RESULT.note);
    expect(OwnerDirect.DIRECT_CAP).toBe(3);
  });
});

describe('rule 2: same-name customers (11 to 25 rows)', () => {
  let customers, serviceRecords, limitSeen;
  const sameName = n => Array.from({ length: n }, (_, i) => ({
    id: id(100 + i), first_name: 'Pat', last_name: 'Example', phone: `94155501${String(i).padStart(2, '0')}`, email: `pat${i}@example.test`,
    address_line1: `${i} Example Way`, city: ['Venice', 'Sarasota', 'Osprey'][i % 3], updated_at: new Date('2026-01-01'), version: '2026-01-01',
  }));

  beforeEach(() => {
    customers = sameName(15);
    serviceRecords = [];
    limitSeen = [];
    db.mockReset().mockImplementation((table) => {
      let limit = Infinity;
      const filters = [];
      const digits = value => String(value || '').replace(/\D/g, '').slice(-10);
      const q = { whereNull: () => q, whereIn: () => q, groupBy: () => q, select: () => q,
        // A contact lookup narrows the rows the way the SQL would; every other query sees all rows.
        where: (fn) => { if (typeof fn === 'function') fn.call(q); return q; },
        whereRaw: (sql, bindings) => {
          if (/regexp_replace\(coalesce\(phone/.test(sql)) filters.push(row => digits(row.phone) === bindings[0]);
          if (/lower\(coalesce\(email/.test(sql)) filters.push(row => String(row.email || '').toLowerCase() === bindings[0]);
          // The "First L., City" lookup: normalized first name, last-name prefix and city.
          if ((sql === '? = ?' || sql === '? LIKE ?') && bindings[0]?.text && /first_name|last_name|city/.test(bindings[0].text)) {
            const norm = value => String(value || '').toLowerCase().trim();
            const column = /first_name/.test(bindings[0].text) ? 'first_name' : /last_name/.test(bindings[0].text) ? 'last_name' : 'city';
            filters.push(row => (sql === '? LIKE ?' ? norm(row[column]).startsWith(String(bindings[1]).replace(/%$/, '')) : norm(row[column]) === bindings[1]));
          }
          return q;
        },
        orWhereRaw: () => q,
        limit: (n) => { limit = n; limitSeen.push(n); return q; },
        first: async () => undefined,
        then: resolve => Promise.resolve(table === 'customers' ? customers.filter(row => filters.every(f => f(row))).slice(0, limit) : table === 'service_records' ? serviceRecords : []).then(resolve) };
      return q;
    });
    db.raw = text => ({ text });
  });

  const ask = prompt => Context.resolve({ prompt, pageData: {}, selectedTarget: null });

  test('gate off: 10 rows is the cap, nothing is listed, the answer asks for a phone or email', async () => {
    const resolved = await ask('update Pat Example notes');
    expect(resolved).toMatchObject({ code: 'target_clarification_required', candidates: [] });
    expect(resolved.error).toMatch(/phone or email/);
    expect(resolved.typedCustomerIds).toBeUndefined();
    expect(Context.customerLookupLimit()).toBe(10);
    const owner = Context.ownerDirectContext(resolved);
    expect(owner.sameNameNote).toBeUndefined();
    expect(owner).not.toHaveProperty('error');
  });

  test('gate on: 15 same-name customers come back as rows with city and last visit, plus the choices note', async () => {
    process.env[ON] = 'true';
    serviceRecords = [{ customer_id: id(100), last_visit: new Date('2026-09-30T00:00:00Z') }, { customer_id: id(101), last_visit: '2026-08-02' }];
    const resolved = await ask('update Pat Example notes');
    expect(resolved.code).toBeUndefined();
    expect(resolved.candidates).toHaveLength(15);
    expect(resolved.candidates[0]).toMatchObject({ label: 'Pat Example', city: 'Venice', last_visit: '2026-09-30' });
    expect(resolved.candidates[1]).toMatchObject({ city: 'Sarasota', last_visit: '2026-08-02' });
    expect(resolved.candidates[2].last_visit).toBeNull();
    expect(Context.customerLookupLimit()).toBe(26);
    const owner = Context.ownerDirectContext(resolved);
    expect(owner.ambiguous).toBe(false);
    expect(owner.candidates).toHaveLength(15);
    expect(owner.sameNameNote).toMatch(/15 customers share the name/);
    expect(owner.sameNameNote).toMatch(/offer_choices/);
    expect(owner.sameNameNote).toMatch(/Do not .* ask for a phone number/);
    // Fifteen same-name rows name nobody: an edit the model picks among them keeps its card.
    expect(owner.typedCustomerIds).toEqual([]);
  });

  test('gate on: exactly 25 rows are still listed; 26 is over the limit and asks for a detail', async () => {
    process.env[ON] = 'true';
    customers = sameName(25);
    expect((await ask('update Pat Example notes')).candidates).toHaveLength(25);
    customers = sameName(30);
    const over = await ask('update Pat Example notes');
    expect(over).toMatchObject({ code: 'target_clarification_required', candidates: [] });
    expect(Context.ownerDirectContext(over).sameNameNote).toMatch(/More than 25 customers/);
    expect(limitSeen).toContain(26);
  });

  test('gate on: a city the owner typed narrows the name to one customer; a phone number names one', async () => {
    process.env[ON] = 'true';
    customers = sameName(3);
    expect((await ask('update Pat Example in Osprey notes')).typedCustomerIds).toEqual([id(102)]);
    const byPhone = await ask('update Pat Example 941-555-0101 notes');
    expect(byPhone.typedCustomerIds).toEqual([id(101)]);
    // A phone no customer carries names nobody.
    expect((await ask('update Pat Example 941-555-9999 notes')).typedCustomerIds).toEqual([]);
  });

  test('gate on: past the 25-row cap, a phone that belongs to the named person still names them (Codex #6369 r2)', async () => {
    process.env[ON] = 'true';
    customers = sameName(30);
    const beyond = customers[29];
    const digits = beyond.phone.replace(/\D/g, '');
    const pretty = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    expect((await ask(`update Pat Example ${pretty} notes`)).typedCustomerIds).toEqual([beyond.id]);
    // A phone of someone with another name is still a conflict.
    customers.push({ ...sameName(1)[0], id: id(900), first_name: 'Lee', last_name: 'Other', phone: '9415559000', email: 'lee@example.test' });
    expect((await ask('update Pat Example 941-555-9000 notes')).typedCustomerIds).toEqual([]);
  });

  test('gate on: a capped name list names nobody, even when one listed row matches the typed city', async () => {
    process.env[ON] = 'true';
    // 30 same-name customers: the lookup stops at 26 and never sees the rest, so a lone city match proves nothing.
    customers = sameName(30);
    customers[1].city = 'Englewood';
    const resolved = await ask('update Pat Example in Englewood notes');
    expect(resolved).toMatchObject({ code: 'target_clarification_required' });
    expect(resolved.typedCustomerIds).toEqual([]);
    const owner = Context.ownerDirectContext(resolved);
    expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id: customers[1].id, updates: { phone: '941-555-0100' } }, null, null, OwnerDirect.targetGrounding(owner))).toBe(false);
    // Directly: incomplete evidence is not named evidence.
    expect(await Context.typedCustomerIds('update Pat Example in Englewood notes', { matches: customers.slice(0, 26), complete: false })).toEqual([]);
  });

  test('gate on: a phone or email two customers share names neither, however many other rows precede them', async () => {
    process.env[ON] = 'true';
    customers = [...sameName(12).map((c, i) => ({ ...c, id: id(300 + i), first_name: 'Other', last_name: `Person${i}`, phone: `94177700${String(i).padStart(2, '0')}`, email: `other${i}@example.test` })), ...sameName(2)];
    customers[12].phone = customers[13].phone = '9415550199';
    customers[12].email = customers[13].email = 'shared@example.test';
    // Two accounts carry the typed number: neither is named. The lookup is bounded at two rows per literal.
    expect((await Context.typedCustomerIds('fix the notes on 941-555-0199', { matches: [], complete: true })).sort()).toEqual([]);
    expect(await Context.typedCustomerIds('fix the notes on shared@example.test', { matches: [], complete: true })).toEqual([]);
    expect(limitSeen).toEqual([2, 2]);
    // A number only one account carries still names that account, even beside a shared one.
    customers[0].phone = '9417770000';
    expect(await Context.typedCustomerIds('fix the notes on 941-777-0000 and 941-555-0199', { matches: [], complete: true })).toEqual([id(300)]);
  });

  test('gate on: more than 5 typed phones or emails name nobody by contact and run no lookup (Codex #6369 security P2)', async () => {
    process.env[ON] = 'true';
    customers = sameName(1);
    customers[0].phone = '9417770001';
    limitSeen.length = 0;
    const many = Array.from({ length: 6 }, (_, i) => `941-777-000${i + 1}`).join(' ');
    expect(await Context.typedCustomerIds(`fix the notes on ${many}`, { matches: [], complete: true })).toEqual([]);
    expect(limitSeen).toEqual([]);
    const five = Array.from({ length: 5 }, (_, i) => `941-777-000${i + 1}`).join(' ');
    expect(await Context.typedCustomerIds(`fix the notes on ${five}`, { matches: [], complete: true })).toEqual([id(100)]);
  });

  test('gate on: a choice-button reply ("Full Name, City") is the pick, so no second round of choices', async () => {
    process.env[ON] = 'true';
    customers = sameName(3);
    const resolved = await ask('Pat Example, Osprey');
    expect(resolved.typedCustomerIds).toEqual([id(102)]);
    const note = Context.ownerDirectContext(resolved).sameNameNote;
    expect(note).toMatch(/picks one of the customers/);
    expect(note).toContain(id(102));
    expect(note).not.toMatch(/offer_choices with/);
    // Without a narrowing detail the choices are still offered.
    expect(Context.ownerDirectContext(await ask('update Pat Example notes')).sameNameNote).toMatch(/Call offer_choices/);
  });

  test('gate on: a unique name plus a phone or email that belongs to a different customer names nobody (Codex r1 P1)', async () => {
    process.env[ON] = 'true';
    customers = [...sameName(1), { ...sameName(1)[0], id: id(400), first_name: 'Other', last_name: 'Person', phone: '9417770000', email: 'other@example.test' }];
    // Name and contact agree: that customer is named.
    expect((await ask('update Pat Example 941-555-0100 notes')).typedCustomerIds).toEqual([id(100)]);
    // The phone or the email is someone else's: unresolved, so neither account is named.
    expect((await ask('update Pat Example 941-777-0000 notes')).typedCustomerIds).toEqual([]);
    expect((await ask('update Pat Example other@example.test notes')).typedCustomerIds).toEqual([]);
    const conflicted = await ask('update Pat Example 941-777-0000 notes');
    expect(conflicted.identityConflict).toBe(true);
    const owner = Context.ownerDirectContext(conflicted);
    // Neither account runs without a card: the name-resolved target is not trusted either (Codex #6369 r2 audit).
    for (const customer_id of [id(100), id(400)]) {
      expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id, updates: { phone: '941-555-0100' } }, null, null, OwnerDirect.targetGrounding(owner))).toBe(false);
    }
    // The customer on screen still counts.
    const onScreen = OwnerDirect.targetGrounding({ ...owner, page: { ids: { customer_id: id(100) } } });
    expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id: id(100), updates: { phone: '941-555-0100' } }, null, null, onScreen)).toBe(true);
  });

  test('gate on: a long "Full Name, City" button becomes "First L., City", unique, under 40 characters, and the reply resolves back (Codex r1 P2)', async () => {
    process.env[ON] = 'true';
    const { validateChoices } = require('../services/intelligence-bar/choice-tools');
    const long = (i, city) => ({ ...sameName(1)[0], id: id(500 + i), first_name: 'Bartholomew', last_name: 'Featherstonehaugh', city, phone: `94155502${String(i).padStart(2, '0')}` });
    customers = [long(0, 'Fort Myers Beach'), long(1, 'Port Charlotte'), long(2, 'Venice'), long(3, 'Venice')];
    const resolved = await ask('update Bartholomew Featherstonehaugh notes');
    const labels = resolved.candidates.map(c => c.choice_label);
    expect(labels).toEqual(['Bartholomew F., Fort Myers Beach', 'Bartholomew F., Port Charlotte', null, null]);
    // Every label that is offered survives offer_choices, and a tap resolves to exactly that customer.
    const offered = labels.filter(Boolean);
    expect(validateChoices({ options: offered })).toEqual(offered);
    for (const label of offered) {
      const reply = await ask(label);
      expect(reply.typedCustomerIds).toEqual([resolved.candidates[labels.indexOf(label)].customer_id]);
    }
    // The two Venice customers share a label: no button, a phone or email is asked for.
    expect(labels[2]).toBeNull();
    expect(labels[3]).toBeNull();
    expect(Context.ownerDirectContext(resolved).sameNameNote).toMatch(/choice_label is null/);
    // A "First L., City" that fits two customers (or none) names nobody.
    customers = [long(0, 'Fort Myers Beach'), { ...long(1, 'Fort Myers Beach'), last_name: 'Fothergill' }];
    expect((await ask('Bartholomew F., Fort Myers Beach')).typedCustomerIds).toEqual([]);
    expect((await ask('Bartholomew F., Sarasota')).typedCustomerIds).toEqual([]);
  });

  test('gate on: a unique name names its customer; the bare phone alone does too', async () => {
    process.env[ON] = 'true';
    customers = sameName(1);
    const resolved = await ask('update Pat Example notes');
    expect(resolved.typedCustomerIds).toEqual([id(100)]);
    expect(resolved.target.customer_id).toBe(id(100));
    customers = sameName(2);
    expect((await ask('fix the notes on 941-555-0101')).typedCustomerIds).toEqual([id(101)]);
  });

  test('gate on: a customer the model found itself is not in the typed list', async () => {
    process.env[ON] = 'true';
    customers = sameName(2);
    const resolved = await ask('fix the notes on the customer who called this morning');
    expect(resolved.typedCustomerIds).toEqual([]);
    const grounding = OwnerDirect.targetGrounding(Context.ownerDirectContext(resolved));
    expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id: id(100), updates: { phone: '941-555-0100' } }, null, null, grounding)).toBe(false);
  });
});

describe('Codex r1 P2: the direct cap counts calls that actually run direct; the prompt states one limit', () => {
  const NAMED = id(1), UNNAMED = id(2);
  const reschedule = n => ({ type: 'tool_use', name: 'reschedule_appointment', input: { appointment_id: id(600 + n), new_date: '2026-11-03' } });
  const pin = customer_id => ({ pinned_appointment: { id: id(600), customer_id, visit_id: null } });

  test('gate on: a message with six reschedule calls is refused as a set before any commits; unnamed ones still card (Codex #6369 r2)', () => {
    process.env[ON] = 'true';
    const grounding = OwnerDirect.targetGrounding({ targets: [], typedCustomerIds: [NAMED], page: { ids: {} } });
    const calls = [1, 2, 3, 4, 5, 6].map(reschedule);
    // More than five such calls in one message: the set goes to the bulk card, decided before the previews.
    const committed = new Map();
    const capped = OwnerDirect.cappedTools(committed, OwnerDirect.messageDirectPlan(calls, () => true, null, grounding));
    expect([...capped]).toEqual(['reschedule_appointment']);
    // Five or fewer are left to the per-preview count.
    expect(OwnerDirect.cappedTools(new Map(), OwnerDirect.messageDirectPlan(calls.slice(0, 5), () => true, null, grounding)).size).toBe(0);
    // Each call is judged on its own preview, in order, as it commits.
    const verdicts = [UNNAMED, UNNAMED, UNNAMED, UNNAMED, UNNAMED, NAMED].map((customer_id) => {
      const direct = OwnerDirect.executesWithoutCard('reschedule_appointment', calls[0].input, pin(customer_id), null, grounding);
      if (!direct) return 'card';
      if (capped.has('reschedule_appointment') || OwnerDirect.dynamicCapReached(committed, 'reschedule_appointment')) return 'refused';
      OwnerDirect.recordDirectCommit(committed, 'reschedule_appointment');
      return 'direct';
    });
    expect(verdicts).toEqual(['card', 'card', 'card', 'card', 'card', 'refused']);
    expect(committed.size).toBe(0); // nothing half-applied
  });

  test('gate on: after 5 direct reschedules the 6th is refused; other tools and gate off is unchanged', () => {
    process.env[ON] = 'true';
    const committed = new Map([['reschedule_appointment', 4]]);
    expect(OwnerDirect.dynamicCapReached(committed, 'reschedule_appointment')).toBe(false);
    OwnerDirect.recordDirectCommit(committed, 'reschedule_appointment');
    expect(OwnerDirect.dynamicCapReached(committed, 'reschedule_appointment')).toBe(true);
    expect(OwnerDirect.dynamicCapReached(committed, 'update_lead_status')).toBe(false);
    delete process.env[ON];
    expect(OwnerDirect.dynamicCapReached(committed, 'reschedule_appointment')).toBe(false);
    // Gate off: the plan still counts them, as today.
    expect(OwnerDirect.messageDirectPlan([reschedule(1), reschedule(2)]).get('reschedule_appointment')).toBe(2);
  });

  test('the owner prompt states exactly one direct-edit limit for the gate state', () => {
    const limits = prompt => ({ old: /Three or more edits with the same tool/.test(prompt), v2: /More than 5 edits with the same tool/.test(prompt), anyThree: /three or more/i.test(prompt) });
    // Gate off: today's prompt, byte for byte.
    expect(OwnerDirect.ownerDirectPrompt()).toBe(OwnerDirect.OWNER_DIRECT_PROMPT);
    expect(limits(OwnerDirect.ownerDirectPrompt())).toEqual({ old: true, v2: false, anyThree: true });
    // Gate on: the prompt and the appended rules block agree on 5.
    process.env[ON] = 'true';
    const full = OwnerDirect.ownerDirectPrompt() + OwnerDirect.OWNER_DIRECT_TARGET_RULES_PROMPT;
    expect(limits(full)).toEqual({ old: false, v2: true, anyThree: false });
    expect(full).toMatch(/Up to 5 edits with the same tool/);
    expect(full).toMatch(/for more than 5 records use the bulk tool/);
  });
});

describe('round 2 fixes (#6369): last visit and capped-name contacts', () => {
  test('last visit reads completed service records only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/task-context.js'), 'utf8');
    expect(src).toMatch(/db\('service_records'\)[^;]*\.where\('status', 'completed'\)/);
  });
});
