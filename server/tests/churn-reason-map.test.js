// Cancel-flow reason pick -> churn code (services/churn-reason-map.js) and the one-time fill migration
// 20261120090000_churn_code_four_picked_cancels. Synthetic data only; the migration runs on a small in-memory fake knex.
//
// Pinned: every v2 cancel reason maps to a code the customers CHECK constraint accepts; a specific pick needs no AI; the AI never
// reads the system's own reason text or the portal form's placeholders, but does read a one-word office note; the fill's rows
// agree with the map; the fill writes a listed row only while it is the same churn (episode, churned_at, stage, code), with one
// audit event each; a second run changes nothing; down() restores only rows up() wrote that still hold its code in that episode.
// churn-classifier is loaded only for its CHURN_REASON_CODES list; no model is called.
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(), callAnthropic: jest.fn() }));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async ({ trx, ...event }) => { trx.__tables.audit_log.push({ id: `a${trx.__tables.audit_log.length + 1}`, ...event }); }),
}));

const { REASON_CODE_VALUES } = require('../services/cancellation-resolution/reason-codes');
const { CHURN_REASON_CODES } = require('../services/churn-classifier');
const { CANCEL_TO_CHURN, churnCodeForCancelReason, churnClassifierInput } = require('../services/churn-reason-map');
const migration = require('../models/migrations/20261120090000_churn_code_four_picked_cancels');

describe('churnCodeForCancelReason', () => {
  test('every v2 cancel reason maps to a churn code the CHECK constraint accepts', () => {
    for (const code of REASON_CODE_VALUES) {
      const churn = churnCodeForCancelReason(code);
      expect(CHURN_REASON_CODES).toContain(churn);
      expect(churn).not.toBe('unclassified');
    }
  });

  test('no pick, an unknown code or an inherited property name is no code', () => {
    expect(churnCodeForCancelReason(null)).toBeNull();
    expect(churnCodeForCancelReason('')).toBeNull();
    expect(churnCodeForCancelReason('because')).toBeNull();
    expect(churnCodeForCancelReason('constructor')).toBeNull();
  });

  test('the fill\'s rows are coded with this map', () => {
    for (const row of migration.ROWS) expect([row.caseReason, CANCEL_TO_CHURN[row.caseReason]]).toEqual([row.caseReason, row.to]);
  });
});

describe('churnClassifierInput', () => {
  const FORM = (label, details) => `Customer requested cancellation of Pest Control. Reason: ${label}. Details: ${details}`;

  test('a specific pick needs no AI, whatever the words', () => {
    expect(churnClassifierInput({ cancelReasonCode: 'price', words: 'too expensive' })).toBeNull();
  });

  test('the system\'s own reason text is never read', () => {
    expect(churnClassifierInput({ reason: 'Portal cancellation request 88885abf-8d4a-4bb0-8b25-74b9ced9acfa' })).toBeNull();
    expect(churnClassifierInput({ reason: 'Admin cancellation request 267d2d31-46e6-48cb-9b31-dc43144d7d50' })).toBeNull();
    expect(churnClassifierInput({ reason: 'Customer cancellation request' })).toBeNull();
    expect(churnClassifierInput({ words: 'Portal cancellation request 88885abf-8d4a-4bb0-8b25-74b9ced9acfa' })).toBeNull();
  });

  test('portal form: placeholders alone are no words; with no pick the legacy label counts, with a pick only the details', () => {
    expect(churnClassifierInput({ words: FORM('Not specified', 'None') })).toBeNull();
    expect(churnClassifierInput({ words: 'Customer requested cancellation. Reason: Not specified. Details: None' })).toBeNull();
    expect(churnClassifierInput({ words: 'Customer requested cancellation. Reason: Cost. Details: None' })).toBe('Reason: Cost');
    expect(churnClassifierInput({ cancelReasonCode: 'other', words: FORM('Other', 'None') })).toBeNull();
    expect(churnClassifierInput({ cancelReasonCode: 'other', words: FORM('Other', 'we sold. the house') })).toBe('Details: we sold. the house');
  });

  test('an office note is read even when it is one word; a pick with no words never falls back to the reason', () => {
    expect(churnClassifierInput({ words: 'price', reason: 'price' })).toBe('price');
    expect(churnClassifierInput({ cancelReasonCode: 'other', reason: 'other' })).toBeNull();
  });

  test('older callers with only a reason: their words are read, capped at 500 characters', () => {
    expect(churnClassifierInput({ reason: '  found it cheaper  ' })).toBe('found it cheaper');
    expect(churnClassifierInput({ reason: 'x'.repeat(600) })).toHaveLength(500);
  });
});

// ---- migration ----
function makeKnex(initial) {
  const tables = JSON.parse(JSON.stringify(initial));
  tables.audit_log = tables.audit_log || [];
  const matches = (row, filters) => filters.every((obj) => Object.entries(obj).every(([k, v]) => (v == null ? row[k] == null : row[k] === v)));
  function builder(name) {
    const filters = [];
    const b = {
      where(obj) { filters.push(obj); return b; },
      select() { return b; },
      async update(patch) {
        const hit = tables[name].filter((r) => matches(r, filters));
        for (const r of hit) Object.assign(r, patch);
        return hit.length;
      },
      then(resolve, reject) {
        return Promise.resolve(tables[name].filter((r) => matches(r, filters)).map((r) => ({ ...r }))).then(resolve, reject);
      },
    };
    return b;
  }
  const knex = (name) => builder(name);
  knex.__tables = tables;
  knex.fn = { now: () => 'NOW' };
  knex.schema = {
    hasTable: async (t) => Object.prototype.hasOwnProperty.call(tables, t),
    hasColumn: async () => true,
  };
  return knex;
}

describe('migration 20261120090000_churn_code_four_picked_cancels', () => {
  const [A, B, C, D] = migration.ROWS;
  const asRow = (r, extra) => ({
    id: r.id, churn_episode_id: r.episode, churned_at: r.churnedAt, pipeline_stage: 'churned', churn_reason_code: 'unclassified', ...extra,
  });
  const seed = () => makeKnex({
    customers: [
      asRow(A), // still that churn: coded
      asRow(B, { churn_episode_id: 'ffffffff-0000-4000-8000-000000000000' }), // churned again since: left
      asRow(C, { pipeline_stage: 'active_customer' }), // reactivated: left
      asRow(D, { churn_reason_code: 'results' }), // coded since: left
      { id: 'other', churn_episode_id: null, churned_at: '2026-09-21', pipeline_stage: 'churned', churn_reason_code: 'unclassified' },
    ],
  });
  const code = (knex, id) => knex.__tables.customers.find((c) => c.id === id).churn_reason_code;

  test('up codes a listed row only while it is the same churn, one audit event each; a second run changes nothing', async () => {
    const knex = seed();
    await migration.up(knex);
    expect(code(knex, A.id)).toBe(A.to);
    expect(code(knex, B.id)).toBe('unclassified');
    expect(code(knex, C.id)).toBe('unclassified');
    expect(code(knex, D.id)).toBe('results');
    expect(code(knex, 'other')).toBe('unclassified');
    const events = knex.__tables.audit_log;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ action: migration.ACTION, resource_id: A.id, critical: true }));
    expect(events[0].metadata).toEqual(expect.objectContaining({ from: 'unclassified', to: A.to, churn_episode_id: A.episode, case_id: A.caseId }));
    expect(`${migration.ACTION}:rollback`.length).toBeLessThanOrEqual(96);
    await migration.up(knex);
    expect(knex.__tables.audit_log).toHaveLength(1);
  });

  test('down restores only what up wrote, in the same episode, and only appends rollback events', async () => {
    const knex = seed();
    knex.__tables.customers.find((c) => c.id === B.id).churn_reason_code = B.to; // set by hand, never by up()
    await migration.up(knex);
    await migration.down(knex);
    expect(code(knex, A.id)).toBe('unclassified');
    expect(code(knex, B.id)).toBe(B.to);
    expect(knex.__tables.audit_log.map((e) => e.action)).toEqual([migration.ACTION, `${migration.ACTION}:rollback`]);
    await migration.down(knex);
    expect(knex.__tables.audit_log).toHaveLength(2);
  });

  test('down keeps a row coded again in a later churn episode, and closes up\'s write as skipped', async () => {
    const knex = seed();
    await migration.up(knex);
    Object.assign(knex.__tables.customers.find((c) => c.id === A.id), { churn_episode_id: 'eeeeeeee-0000-4000-8000-000000000000' });
    await migration.down(knex);
    expect(code(knex, A.id)).toBe(A.to);
    expect(knex.__tables.audit_log.map((e) => [e.action, e.metadata.skipped])).toEqual([
      [migration.ACTION, undefined], [`${migration.ACTION}:rollback`, 'changed since up'],
    ]);
  });

  test('up/down/up/down with a staff correction between: the staff\'s later pick of the same code survives', async () => {
    const knex = seed();
    const rowA = knex.__tables.customers.find((c) => c.id === A.id);
    await migration.up(knex);
    rowA.churn_reason_code = 'results'; // staff correct it
    await migration.down(knex); // skipped: corrected since
    rowA.churn_reason_code = A.to; // staff later pick the migration's code themselves
    await migration.up(knex); // not 'unclassified': no write
    await migration.down(knex); // nothing of up's left open
    expect(rowA.churn_reason_code).toBe(A.to);
    expect(knex.__tables.audit_log).toHaveLength(2);
  });
});
