/**
 * Owner-direct mode (owner ruling 2026-10-01, GATE_IB_OWNER_DIRECT):
 * the pure pieces — who gets it, which tools skip the card, and what the
 * target check stops refusing (and what it still refuses) for that login.
 * The route wiring is in admin-intelligence-bar-owner-direct.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-dedupe', () => ({ duplicatePairEligibility: jest.fn(async () => ({ eligible: false })) }));
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');
const policy = require('../services/intelligence-bar/action-policy.json');
const { UI_GATED_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const LEAD = '40000000-0000-4000-8000-000000000001';
const LEAD_TWIN = '40000000-0000-4000-8000-000000000002';
const PROPERTY = '30000000-0000-4000-8000-000000000001';
const MISSING = '50000000-0000-4000-8000-000000000009';
let rows;
beforeEach(() => {
  rows = {
    customers: [{ id: A, first_name: 'Synthetic', last_name: 'Person' }, { id: B, first_name: 'Other', last_name: 'Person' }],
    customer_properties: [{ id: PROPERTY, customer_id: B, active: true }],
    // Two unlinked leads share the only name they have.
    leads: [{ id: LEAD, customer_id: null, first_name: null, last_name: 'Fixture' }, { id: LEAD_TWIN, customer_id: null, first_name: null, last_name: 'Fixture' }],
  };
  db.mockReset().mockImplementation(table => {
    let ids, id, nameMatch = false;
    const q = { where: key => { if (key && typeof key === 'object' && key.id) id = key.id; return q; }, whereNull: () => q, limit: () => q, select: () => q,
      first: async () => (rows[table] || []).find(row => row.id === id),
      whereRaw: () => { nameMatch = true; return q; },
      // A name lookup (whereIn on a normalized-name expression) sees every
      // row; namedCustomers then keeps only the rows whose name the clause
      // actually states.
      whereIn: (key, values) => { if (key === 'id') ids = values; else nameMatch = true; return q; },
      then: resolve => Promise.resolve(ids ? (rows[table] || []).filter(row => ids.includes(row.id)) : nameMatch ? rows[table] || [] : []).then(resolve) };
    return q;
  });
  db.raw = text => ({ text });
});

const strict = (overrides = {}) => ({ targets: [], page: { ids: {} }, requestPhrase: 'add jay as the first name for the fixture lead', ...overrides });
const direct = (overrides = {}) => Context.ownerDirectContext(strict(overrides));

describe('who gets owner-direct', () => {
  const owner = { techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } };
  afterEach(() => { delete process.env.GATE_IB_OWNER_DIRECT; });

  test('needs the gate AND the owner login', () => {
    expect(OwnerDirect.ownerDirectLive(owner)).toBe(false);
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    expect(OwnerDirect.ownerDirectLive(owner)).toBe(true);
    expect(OwnerDirect.ownerDirectLive({ techRole: 'admin', technician: { email: 'office@example.test' } })).toBe(false);
    expect(OwnerDirect.ownerDirectLive({ techRole: 'technician', technician: { email: 'contact@wavespestcontrol.com' } })).toBe(false);
    expect(OwnerDirect.ownerDirectLive({ techRole: 'admin', technician: {} })).toBe(false);
  });
});

describe('which writes skip the card', () => {
  test('every listed tool is a confirm-gated internal single-record write', () => {
    for (const name of OwnerDirect.OWNER_DIRECT_TOOL_NAMES) {
      expect({ name, ...policy[name] }).toMatchObject({ name, kind: 'internal_write', approval: 'ui_confirm' });
      expect(policy[name].scope).not.toBe('route_wide');
      expect(name.startsWith('bulk_')).toBe(false);
      expect(UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test('customer messages, money, bulk and destructive writes keep their card', () => {
    for (const name of ['send_sms', 'reply_via_sms', 'send_email_reply', 'trigger_review_request', 'submit_review_reply',
      'bulk_update_customers', 'bulk_update_leads', 'optimize_all_routes', 'swap_tech_assignments', 'move_stops_to_day',
      'create_appointment', 'cancel_appointment', 'cancel_plan', 'merge_customers', 'save_customer_estimate', 'switch_appointment_property',
      'create_pending_estimate', 'approve_price', 'set_railway_gate', 'request_instant_payout']) {
      expect([name, OwnerDirect.executesWithoutCard(name, {})]).toEqual([name, false]);
    }
    // No external action is ever on the list, whatever is added later.
    for (const [name, entry] of Object.entries(policy)) {
      if (entry.kind !== 'internal_write') expect([name, OwnerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)]).toEqual([name, false]);
    }
  });

  test('the lead and schedule edits the owner asked for execute directly', () => {
    for (const name of ['update_lead_contact', 'update_lead_status', 'reschedule_appointment', 'update_property_access']) {
      expect([name, OwnerDirect.executesWithoutCard(name, {})]).toEqual([name, true]);
    }
  });

  test('assign_technician is direct for one ungrouped stop; several stops, a grouped stop, or no preview keep the card', () => {
    const one = { service_ids: [A], technician_name: 'Synthetic Tech' };
    expect(OwnerDirect.executesWithoutCard('assign_technician', one, { stops: [{ id: A }] })).toBe(true);
    expect(OwnerDirect.executesWithoutCard('assign_technician', one, { stops: [{ id: A, grouped_visit_id: 'visit-1' }] })).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', one, { stops: [{ id: A }, { id: B }] })).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', one, { stops: [] })).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', one, {})).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', one)).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', { service_ids: [A, B], technician_name: 'Synthetic Tech' }, { stops: [{ id: A }] })).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', { service_ids: [], technician_name: 'Synthetic Tech' }, { stops: [] })).toBe(false);
    expect(OwnerDirect.executesWithoutCard('assign_technician', { technician_name: 'Synthetic Tech' }, { stops: [{ id: A }] })).toBe(false);
  });

  test('runDirectCommit: claims through the given commit path, cancels only an unconsumed approval, and reports uncertainty', async () => {
    const payload = { id: 'pa-1', contract_hash: 'abc' };
    const calls = [];
    const commit = result => async (id, hash) => { calls.push(['commit', id, hash]); return result; };
    const cancel = async id => { calls.push(['cancel', id]); };

    const ok = await OwnerDirect.runDirectCommit(payload, { commit: commit({ status: 200, claimed: true, body: { success: true, outcome: 'completed', result: { success: true } } }), cancel });
    expect(ok).toMatchObject({ actionId: 'pa-1', uncertain: false, failed: false, result: { executed: true } });
    expect(calls).toEqual([['commit', 'pa-1', 'abc']]);

    calls.length = 0;
    const unclaimable = await OwnerDirect.runDirectCommit(payload, { commit: commit({ status: 409, claimed: false, body: { error: 'Pending action expired' } }), cancel });
    expect(unclaimable).toMatchObject({ actionId: null, uncertain: false, failed: true, result: { executed: false, error: 'Pending action expired' } });
    expect(calls).toEqual([['commit', 'pa-1', 'abc'], ['cancel', 'pa-1']]);

    calls.length = 0;
    const unknown = await OwnerDirect.runDirectCommit(payload, { commit: commit({ status: 200, claimed: true, body: { success: false, outcome: 'outcome_unknown', result: { outcome_unknown: true } } }), cancel });
    expect(unknown).toMatchObject({ actionId: 'pa-1', uncertain: true, failed: true, result: { executed: null } });
    expect(calls).toEqual([['commit', 'pa-1', 'abc']]);

    calls.length = 0;
    const unsaved = await OwnerDirect.runDirectCommit(payload, { commit: commit({ status: 200, claimed: true, body: { success: true, outcome: 'completed', result: {}, receiptPersisted: false, warning: 'w' } }), cancel });
    expect(unsaved).toMatchObject({ actionId: 'pa-1', uncertain: true, failed: false });

    // A commit that throws before claiming releases the approval and rethrows.
    calls.length = 0;
    await expect(OwnerDirect.runDirectCommit(payload, { commit: async () => { throw new Error('db down'); }, cancel })).rejects.toThrow('db down');
    expect(calls).toEqual([['cancel', 'pa-1']]);
    // A failing cancel never masks the commit result.
    const cancelFails = await OwnerDirect.runDirectCommit(payload, { commit: commit({ status: 409, claimed: false, body: { error: 'expired' } }), cancel: async () => { throw new Error('nope'); } });
    expect(cancelFails.failed).toBe(true);
  });

  test('the card-aware owner prompt never says writes execute without a card', () => {
    expect(OwnerDirect.OWNER_DIRECT_PROMPT).toMatch(/no confirmation card/);
    expect(OwnerDirect.OWNER_DIRECT_CARDED_PROMPT).not.toMatch(/no confirmation card/);
    expect(OwnerDirect.OWNER_DIRECT_CARDED_PROMPT).toMatch(/Every write shows a one-tap confirmation card/);
    expect(OwnerDirect.OWNER_DIRECT_CARDED_PROMPT).toMatch(/Never claim a change is done/);
  });

  test('update_customer skips the card only for name, phone, address, source and note fields', () => {
    const run = updates => OwnerDirect.executesWithoutCard('update_customer', { customer_id: A, updates });
    expect(run({ first_name: 'Jay' })).toBe(true);
    expect(run({ phone: '9415550100', notes: 'gate code moved' })).toBe(true);
    expect(run({ lead_source: 'Referral' })).toBe(true);
    // Money, a customer message, and lifecycle (churn / reactivation) keep the card.
    expect(run({ monthly_rate: 49 })).toBe(false);
    expect(run({ email: 'new@example.test' })).toBe(false);
    expect(run({ first_name: 'Jay', email: 'new@example.test' })).toBe(false);
    expect(run({ pipeline_stage: 'churned' })).toBe(false);
    expect(run({ pipeline_stage: 'won' })).toBe(false);
    expect(run({ pipeline_stage: 'active_customer' })).toBe(false);
    expect(run({ first_name: 'Jay', waveguard_tier: 'Gold' })).toBe(false);
    expect(run({ active: false })).toBe(false);
    expect(run({ some_new_field: 1 })).toBe(false);
    expect(run({})).toBe(false);
    expect(run(undefined)).toBe(false);
    expect(run(['first_name'])).toBe(false);
  });

  test('the model is told plainly whether the direct write ran', () => {
    expect(OwnerDirect.directModelResult({ body: { success: true, outcome: 'completed', result: { success: true } } }))
      .toMatchObject({ executed: true, outcome: 'completed' });
    const refused = OwnerDirect.directModelResult({ body: { error: 'Pending action expired' } });
    expect(refused).toMatchObject({ executed: false, error: 'Pending action expired' });
    expect(refused.note).toMatch(/did NOT complete/);
    expect(OwnerDirect.directModelResult({ body: { success: false, outcome: 'failed', result: { error: 'Lead not found' } } }))
      .toMatchObject({ executed: false, error: 'Lead not found' });
    expect(OwnerDirect.directModelResult(null)).toMatchObject({ executed: false });
    // Unknown is its own state: the mutation may have committed.
    const unknown = OwnerDirect.directModelResult({ body: { success: false, outcome: 'outcome_unknown', result: { outcome_unknown: true, code: 'execution_interrupted' } } });
    expect(unknown).toMatchObject({ executed: null, outcome: 'outcome_unknown' });
    expect(unknown.note).toMatch(/Do NOT call this tool again/);
    // A saved outcome with no recovery record carries the commit path's warning.
    const unsaved = OwnerDirect.directModelResult({ body: { success: true, outcome: 'completed', result: { success: true }, receiptPersisted: false, warning: 'Do not repeat the action.' } });
    expect(unsaved).toMatchObject({ executed: true, receiptPersisted: false, warning: 'Do not repeat the action.' });
    expect(unsaved.note).toMatch(/Do not repeat/);
  });
});

describe('owner-direct task context', () => {
  test('drops the resolution error and the ambiguity, keeps a resolved customer', () => {
    const opened = Context.ownerDirectContext({ error: 'The selected customer conflicts with the current request', code: 'context_mismatch', selectable: true });
    expect(opened).toMatchObject({ ownerDirect: true, ambiguous: false, targets: [], target: null, candidates: [], page: { ids: {}, records: {} } });
    expect(opened.error).toBeUndefined();
    expect(opened.code).toBeUndefined();
    expect(opened.selectable).toBeUndefined();
    const target = { customer_id: A };
    expect(Context.ownerDirectContext({ target, targets: [target], ambiguous: true })).toMatchObject({ target, targets: [target], ambiguous: false, ownerDirect: true });
  });
});

describe('target check for the owner login', () => {
  test('an unlinked lead that shares its name is the target the bar picked', async () => {
    const params = { lead_id: LEAD, lead_name: 'Fixture', first_name: 'Jay' };
    expect(await Context.validateRecordTarget(params, strict(), { toolName: 'update_lead_contact' })).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget(params, direct(), { toolName: 'update_lead_contact' })).toBeNull();
    expect(await Context.validateRecordTarget({ lead_id: LEAD, new_status: 'contacted' }, direct(), { toolName: 'update_lead_status' })).toBeNull();
  });

  test('a customer outside the task, an ambiguous request and a named-but-unresolved one do not refuse', async () => {
    const params = { customer_id: B, updates: { first_name: 'Jay' } };
    const task = { targets: [{ customer_id: A }] };
    expect(await Context.validateRecordTarget(params, strict(task), { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget(params, direct(task), { toolName: 'update_customer' })).toBeNull();
    expect(await Context.validateRecordTarget(params, strict({ ambiguous: true }), { toolName: 'update_customer' })).toMatchObject({ error: 'Name one customer for this action' });
    expect(await Context.validateRecordTarget(params, direct({ ambiguous: true }), { toolName: 'update_customer' })).toBeNull();
    expect(await Context.validateRecordTarget({ customer_name: 'Other Person' }, strict(), { toolName: 'update_customer' })).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget({ customer_name: 'Other Person' }, direct(), { toolName: 'update_customer' })).toBeNull();
  });

  test('a customer-scoped request no longer blocks a route-wide write', async () => {
    const named = { namesRequested: true };
    expect(await Context.validateRecordTarget({ date: '2026-10-02' }, strict(named), { toolName: 'optimize_all_routes' })).toMatchObject({ code: 'customer_scope_required' });
    expect(await Context.validateRecordTarget({ date: '2026-10-02' }, direct(named), { toolName: 'optimize_all_routes' })).toBeNull();
  });

  test('the approval binding is still minted for the stored action', async () => {
    const accepted = await Context.validateRecordTarget({ lead_id: LEAD, first_name: 'Jay' }, direct(), { toolName: 'update_lead_contact', forApproval: true });
    expect(accepted.references).toEqual([{ kind: 'lead_id', id: LEAD }]);
    expect(typeof accepted.actionBinding).toBe('string');
    // The exemption is part of the proof, so the confirm-time re-check
    // (which runs against the proof, not the live request) keeps it.
    expect(accepted.ownerDirect).toBe(true);
    const strictProof = await Context.validateRecordTarget({ lead_id: LEAD, first_name: 'Jay' }, strict({ targets: [{ customer_id: A }] }), { toolName: 'update_lead_contact', forApproval: true });
    expect(strictProof.ownerDirect).toBeUndefined();
  });

  test('a route-wide write proposed with a customer target still confirms against its proof', async () => {
    const params = { date: '2026-10-02' };
    const task = { targets: [{ customer_id: A }], target: { customer_id: A } };
    const proof = await Context.validateRecordTarget(params, direct(task), { toolName: 'optimize_all_routes', forApproval: true });
    expect(proof).toMatchObject({ ownerDirect: true, targets: [{ customer_id: A }] });
    // Confirm-time: the stored proof is the context.
    expect(await Context.validateRecordTarget({ ...params, _ib_task_context: proof }, proof, { toolName: 'optimize_all_routes' })).toBeNull();
    // Without the flag the same proof refuses before reaching the binding.
    const { ownerDirect: _flag, ...stripped } = proof;
    expect(await Context.validateRecordTarget({ ...params, _ib_task_context: stripped }, stripped, { toolName: 'optimize_all_routes' })).toMatchObject({ code: 'customer_scope_required' });
    // A changed action still fails the binding for the owner too.
    expect(await Context.validateRecordTarget({ date: '2026-10-03', _ib_task_context: proof }, proof, { toolName: 'optimize_all_routes' })).toMatchObject({ code: 'target_changed' });
  });

  test('facts about the data still refuse: bad id, missing record, cross-customer record', async () => {
    expect(await Context.validateRecordTarget({ lead_id: 'not-a-uuid' }, direct(), { toolName: 'update_lead_contact' })).toMatchObject({ code: 'invalid_target' });
    expect(await Context.validateRecordTarget({ lead_id: MISSING }, direct(), { toolName: 'update_lead_contact' })).toMatchObject({ code: 'record_unavailable' });
    expect(await Context.validateRecordTarget({ customer_id: A, property_id: PROPERTY }, direct(), { toolName: 'update_customer_property' }))
      .toMatchObject({ code: 'target_relationship_mismatch' });
  });

  test('an unclassified tool is refused for the owner too', async () => {
    expect((await Context.validateRecordTarget({}, direct(), { toolName: 'no_such_tool' })).error).toBeTruthy();
  });

  test('the flag only counts when it is exactly true', async () => {
    const params = { lead_id: LEAD, first_name: 'Jay' };
    for (const ownerDirect of ['true', 1, {}, false, undefined]) {
      expect(await Context.validateRecordTarget(params, { ...strict(), ownerDirect }, { toolName: 'update_lead_contact' }))
        .toMatchObject({ code: 'target_clarification_required' });
    }
  });
});

describe('reads for the owner login', () => {
  const schema = { properties: { search: {} } };

  test('a read the task check would refuse runs as the model called it', async () => {
    const params = { search: 'Fixture' };
    for (const overrides of [{ namesRequested: true }, { ambiguous: true }, { contactRequested: true }]) {
      expect((await Context.prepareReadInput(params, strict(overrides), { toolName: 'query_leads', schema })).error).toBeTruthy();
      expect(await Context.prepareReadInput(params, direct(overrides), { toolName: 'query_leads', schema })).toEqual({ input: params });
    }
  });

  test('a read that fits the task keeps its bound customer', async () => {
    const task = { targets: [{ customer_id: A }], target: { customer_id: A } };
    const prepared = await Context.prepareReadInput({}, direct(task), { toolName: 'get_customer_detail', schema: { properties: { customer_id: {} } } });
    expect(prepared.input.customer_id).toBe(A);
  });

  test('conflicting selectors on a read refuse for every login and are never forwarded', async () => {
    const schemaWithSelectors = { properties: { customer_id: {}, customer_name: {}, phone: {} } };
    // Customer A by name, customer B's id: the reader would answer about B.
    const conflict = { customer_name: 'Synthetic Person', customer_id: B };
    expect(await Context.prepareReadInput(conflict, strict({ targets: [{ customer_id: A }] }), { toolName: 'get_conversation_thread', schema: schemaWithSelectors })).toMatchObject({ code: 'selector_conflict' });
    expect(await Context.prepareReadInput(conflict, direct(), { toolName: 'get_conversation_thread', schema: schemaWithSelectors })).toMatchObject({ code: 'selector_conflict' });
    expect(await Context.prepareReadInput(conflict, direct({ targets: [{ customer_id: A }] }), { toolName: 'get_conversation_thread', schema: schemaWithSelectors })).toMatchObject({ code: 'selector_conflict' });
    // The same name with its own id is fine.
    const agree = await Context.prepareReadInput({ customer_name: 'Synthetic Person', customer_id: A }, direct({ targets: [{ customer_id: A }] }), { toolName: 'get_conversation_thread', schema: schemaWithSelectors });
    expect(agree.input.customer_id).toBe(A);
    // A name outside the task with no id is a scope refusal, which the owner
    // login bypasses.
    const outside = { customer_name: 'Other Person' };
    expect(await Context.prepareReadInput(outside, strict({ targets: [{ customer_id: A }] }), { toolName: 'get_conversation_thread', schema: schemaWithSelectors })).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.prepareReadInput(outside, direct({ targets: [{ customer_id: A }] }), { toolName: 'get_conversation_thread', schema: schemaWithSelectors })).toEqual({ input: outside });
  });

  test('a bad record id on a read still refuses', async () => {
    expect(await Context.prepareReadInput({ customer_id: 'nope' }, direct(), { toolName: 'get_customer_detail', schema: { properties: { customer_id: {} } } }))
      .toMatchObject({ code: 'invalid_target' });
  });
});
