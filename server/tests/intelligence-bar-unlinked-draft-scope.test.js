/**
 * An Agent Review draft with no customer (an unknown sender's text) inside the task scope (Codex #6931 P1): validateRecordTarget
 * refuses it inside a task for a specific customer, and outside one admits only the exact draft the request typed. Real task-context
 * (resolve + validateRecordTarget) over a db stand-in; synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');

const A = '10000000-0000-4000-8000-0000000000a1';
const UNLINKED = '20000000-0000-4000-8000-0000000000d1';
const OTHER_UNLINKED = '20000000-0000-4000-8000-0000000000d2';
const LINKED_A = '20000000-0000-4000-8000-0000000000d3';
let rows;
let lookupRows;

beforeEach(() => {
  lookupRows = [];
  rows = {
    agent_decisions: [{ id: UNLINKED, customer_id: null }, { id: OTHER_UNLINKED, customer_id: null }, { id: LINKED_A, customer_id: A }],
    customers: [{ id: A, first_name: 'Synthetic', last_name: 'Person', version: '2026-09-01 12:00:00.123456+00' }],
  };
  db.mockReset().mockImplementation((table) => {
    let ids;
    const q = {
      where: () => q, first: async () => undefined, whereRaw: () => q, whereNull: () => q, limit: () => q, select: () => q, distinct: () => q,
      whereIn: (key, values) => { if (key === 'id') ids = values; return q; },
      then: (resolve) => Promise.resolve(ids ? (rows[table] || []).filter((row) => ids.includes(row.id)) : lookupRows).then(resolve),
    };
    return q;
  });
  db.raw = (text) => ({ text });
});

const validate = (decisionId, task) => Context.validateRecordTarget({ decision_id: decisionId }, task, { toolName: 'approve_agent_review_draft' });

describe('an unlinked Agent Review draft (decision with no customer)', () => {
  test('inside a task for a resolved customer it is refused, with or without the id typed', async () => {
    lookupRows = [rows.customers[0]];
    const task = await Context.resolve({ prompt: 'Approve the suggested reply for Synthetic Person', pageData: {} });
    expect(task.targets).toHaveLength(1);
    expect(await validate(UNLINKED, task)).toMatchObject({ code: 'target_clarification_required' });
    const typed = await Context.resolve({ prompt: `Approve the suggested reply for this customer, decision ${UNLINKED}`, pageData: { customer_id: A } });
    expect(typed.targets.map((t) => t.customer_id)).toEqual([A]);
    expect(typed.requestedRecords.decision_id).toEqual([UNLINKED]);
    expect(await validate(UNLINKED, typed)).toMatchObject({ code: 'target_clarification_required' });
  });

  test('inside a task for a viewed customer page it is refused', async () => {
    const task = await Context.resolve({ prompt: 'Approve the suggested reply for this customer', pageData: { customer_id: A } });
    expect(task.targets.map((t) => t.customer_id)).toEqual([A]);
    expect(await validate(UNLINKED, task)).toMatchObject({ code: 'target_clarification_required' });
    expect(await validate(LINKED_A, task)).toBeNull();
  });

  test('inside a task for a name that did not resolve it is refused', async () => {
    const task = await Context.resolve({ prompt: 'Approve the suggested reply for Nobody Matching', pageData: {} });
    expect(task.targets || []).toEqual([]);
    expect(await validate(UNLINKED, task)).toMatchObject({ code: 'target_clarification_required' });
  });

  test('outside a customer task, only the exact draft the request typed is admitted', async () => {
    const task = await Context.resolve({ prompt: `Approve the suggested reply decision ${UNLINKED}`, pageData: {} });
    expect(task.requestedRecords.decision_id).toEqual([UNLINKED]);
    expect(await validate(UNLINKED, task)).toBeNull();
    expect(await validate(OTHER_UNLINKED, task)).toMatchObject({ code: 'target_clarification_required' });
  });

  test('outside a customer task, a request that types no id does not admit it', async () => {
    const task = await Context.resolve({ prompt: 'Approve the suggested reply waiting from the unknown number', pageData: {} });
    expect(await validate(UNLINKED, task)).toMatchObject({ code: 'target_clarification_required' });
  });
});
