// GATE_CUSTOMER_LAST_TOUCH: the Intelligence Bar customer search, the admin MCP
// (it proxies the bar) and the admin customer directory serve the newest PERSON
// touch under the same keys. No database: knex compiles with the pg dialect and
// every query is captured and answered from a canned list.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockQueries = [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  knex.client.acquireConnection = async () => ({});
  knex.client.releaseConnection = async () => {};
  knex.client._query = async (conn, obj) => {
    mockQueries.push(obj.sql);
    const sql = obj.sql;
    let rows = [];
    if (/count\(\*\) as "count"/i.test(sql)) rows = [{ count: '1' }];
    else if (/from "customers"/i.test(sql)) {
      rows = [{ id: 'c1', first_name: 'Pat', last_name: 'Sample', last_contact_date: '2026-01-01T00:00:00.000Z', ...(/ as last_touch_at/.test(sql) ? { last_touch_at: '2026-10-30T12:00:00.000Z' } : {}) }];
    }
    obj.response = { rows, rowCount: rows.length };
    return obj;
  };
  knex.client.processResponse = (obj) => (obj.method === 'first' ? obj.response.rows[0] : obj.response.rows);
  return knex;
});

const { contactTouchSql } = require('../services/customer-intelligence/quiet-customers');
const gates = require('../config/feature-gates');
const { executeTool } = require('../services/intelligence-bar/tools');
const router = require('../routes/admin-customers');

const GATE = 'GATE_CUSTOMER_LAST_TOUCH';
const saved = process.env[GATE];
beforeEach(() => { mockQueries.length = 0; delete process.env[GATE]; });
afterAll(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

describe('contactTouchSql', () => {
  const sql = contactTouchSql('customers');

  test('keys every source on the customer alias', () => {
    expect(sql.match(/= customers\.id/g)).toHaveLength(4);
    expect(contactTouchSql('c')).toContain('= c.id');
  });

  test('counts inbound texts (not recruiting job_ texts) and delivered texts a person sent', () => {
    expect(sql).toContain("sl.direction = 'inbound'");
    expect(sql).toContain("sl.message_type NOT LIKE 'job\\_%'");
    expect(sql).toContain("sl.direction = 'outbound' AND ((COALESCE(sl.metadata->>'human_authored'");
    expect(sql).toContain("sl.status = 'delivered'");
  });

  test('never counts an automated outbound text: the outbound branch needs operator provenance', () => {
    const outbound = sql.slice(sql.indexOf("sl.direction = 'outbound'"), sql.indexOf('FROM call_log'));
    expect(outbound).toContain('sl.admin_user_id IS NOT NULL');
    expect(outbound).toContain(' AND (sl.status = ');
  });

  test('counts a call a person placed and spoke on, or an inbound call a human answered, never a bare call row', () => {
    const calls = sql.slice(sql.indexOf('FROM call_log'), sql.indexOf('FROM emails'));
    expect(calls).toContain("cl.direction = 'outbound' AND (cl.source IN (");
    expect(calls).toContain("cl.v2_extraction_status = 'valid'");
    expect(calls).toContain("cl.direction = 'inbound' AND cl.answered_by = 'human'");
  });

  test('counts inbound mail linked to the customer and never a Gmail SENT row', () => {
    const mail = sql.slice(sql.indexOf('FROM emails'), sql.indexOf('FROM service_records'));
    expect(mail).toContain('em.customer_id = customers.id');
    // customer_id alone is not sender proof: the sender must be the address on file
    expect(mail).toContain('LOWER(em.from_address) = LOWER(TRIM(customers.email))');
    expect(mail).toContain("NOT COALESCE((jsonb_exists(em.label_ids::jsonb, 'SENT') AND NOT jsonb_exists(em.label_ids::jsonb, 'INBOX')), FALSE)");
    // forged-From mail Gmail filed as spam, or the spam blocker quarantined, never moves the date
    expect(mail).toContain("NOT COALESCE(jsonb_exists(em.label_ids::jsonb, 'SPAM'), FALSE) AND em.quarantined_at IS NULL");
  });

  test('counts a completed visit only, as a timestamp, and GREATEST leaves NULL when there is none', () => {
    expect(sql).toContain("COALESCE(sr.status, 'completed') = 'completed'");
    expect(sql).toContain("(MAX(sr.service_date) + TIME '12:00')::timestamptz");
    expect(sql.startsWith('GREATEST(')).toBe(true);
    expect(sql).not.toContain('COALESCE((SELECT MAX');
  });

  test('carries no bare question mark (a knex raw would read it as a binding)', () => {
    expect(sql).not.toContain('?');
  });
});

describe('customerLastTouchLive', () => {
  test('is strict and dark by default', () => {
    expect(gates.customerLastTouchLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'false']) { process.env[GATE] = v; expect(gates.customerLastTouchLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(gates.customerLastTouchLive()).toBe(true);
  });
});

describe('Intelligence Bar query_customers (and the admin MCP that proxies it)', () => {
  test('gate off: serves the stored column and selects no touch subquery', async () => {
    const out = await executeTool('query_customers', { search: 'Pat' });
    expect(out.customers[0].last_contact_date).toBe('2026-01-01T00:00:00.000Z');
    expect(mockQueries.join('\n')).not.toContain('last_touch_at');
    expect(mockQueries.join('\n')).not.toContain('FROM emails em');
  });

  test('gate on: selects the builder SQL and serves it under the same key', async () => {
    process.env[GATE] = 'true';
    const out = await executeTool('query_customers', { search: 'Pat' });
    expect(out.customers[0].last_contact_date).toBe('2026-10-30T12:00:00.000Z');
    const page = mockQueries.find((q) => q.includes('last_touch_at'));
    expect(page).toContain(`${contactTouchSql('customers')} as last_touch_at`);
  });
});

describe('admin customer directory', () => {
  const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  const handler = layer.route.stack.at(-1).handle;
  const list = async (query) => {
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await handler({ query, techRole: 'admin' }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res.json.mock.calls[0][0];
  };
  const pageQuery = () => mockQueries.find((q) => /limit \$?\d|limit \?/i.test(q) && /"customers"\.\*/.test(q));

  test('gate off: stored column, old ORDER BY last_contact_date', async () => {
    const body = await list({ sort: 'last_contact', order: 'desc' });
    expect(body.customers[0].lastContactDate).toBe('2026-01-01T00:00:00.000Z');
    const q = pageQuery();
    expect(q).toContain('order by last_contact_date desc, LOWER(');
    expect(q).not.toContain('last_touch_at');
  });

  test.each(['asc', 'desc'])('gate on: serves the touch and sorts %s by the builder SQL, NULLS LAST', async (order) => {
    process.env[GATE] = 'true';
    const body = await list({ sort: 'last_contact', order });
    expect(body.customers[0].lastContactDate).toBe('2026-10-30T12:00:00.000Z');
    const q = pageQuery();
    expect(q).toContain('as last_touch_at');
    expect(q).toContain(`${contactTouchSql('customers')} ${order} NULLS LAST`);
    expect(q).not.toContain('last_contact_date asc');
    expect(q).not.toContain('last_contact_date desc');
  });

  test('gate on, another sort: still serves the touch, sort unchanged', async () => {
    process.env[GATE] = 'true';
    await list({ sort: 'revenue', order: 'asc' });
    expect(pageQuery()).toContain('order by lifetime_revenue_net asc');
    expect(pageQuery()).not.toContain(`${contactTouchSql('customers')} asc NULLS LAST`);
  });

  test('detail: gate off serves the stored column and runs no query', async () => {
    const stored = new Date('2026-01-01T00:00:00Z');
    await expect(router._private.servedLastContactDate({ id: 'c1', last_contact_date: stored })).resolves.toBe(stored);
    expect(mockQueries).toEqual([]);
  });

  test('detail: gate on reads the builder SQL for that customer and serves it', async () => {
    process.env[GATE] = 'true';
    const touch = await router._private.servedLastContactDate({ id: 'c1', last_contact_date: 'stored' });
    expect(touch).toBe('2026-10-30T12:00:00.000Z');
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toContain(`${contactTouchSql('customers')} as last_touch_at`);
    expect(mockQueries[0]).toContain('"customers"."id" = $1');
  });
});
