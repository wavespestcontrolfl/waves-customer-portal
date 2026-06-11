jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { TOOLS, executeTool } = require('../services/intelligence-bar/tools');
const { COMMS_TOOLS, COMMS_READ_TOOLS } = require('../services/intelligence-bar/comms-tools');

function makeDuplicateLookup(existing) {
  const q = {
    whereNull: jest.fn(() => q),
    where: jest.fn((arg) => {
      if (typeof arg === 'function') {
        const clause = {
          whereRaw: jest.fn(() => clause),
          orWhereRaw: jest.fn(() => clause),
        };
        arg.call(clause);
      }
      return q;
    }),
    orderBy: jest.fn(() => q),
    first: jest.fn(async () => existing),
  };
  return q;
}

function makeTrx(calls) {
  const account = { id: 'acct-1' };
  return jest.fn((table) => {
    const q = {
      insert: jest.fn((row) => {
        calls.push({ table, row });
        return q;
      }),
      returning: jest.fn(async () => {
        if (table === 'customer_accounts') return [account];
        const row = calls.find(c => c.table === 'customers')?.row || {};
        return [{ id: 'cust-1', ...row }];
      }),
      onConflict: jest.fn(() => q),
      ignore: jest.fn(async () => undefined),
    };
    return q;
  });
}

describe('intelligence bar create_customer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('create_customer is exposed in the base toolset', () => {
    expect(TOOLS.map(t => t.name)).toContain('create_customer');
  });

  test('rejects when first_name or phone is missing', async () => {
    expect(await executeTool('create_customer', { phone: '9415550100' }))
      .toEqual({ error: 'first_name and phone are required' });
    expect(await executeTool('create_customer', { first_name: 'Jeff' }))
      .toEqual({ error: 'first_name and phone are required' });
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects a phone with fewer than 10 digits', async () => {
    const result = await executeTool('create_customer', { first_name: 'Jeff', phone: '941-555' });
    expect(result).toEqual({ error: 'phone must include at least 10 digits' });
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects dead-end pipeline stages at creation', async () => {
    const result = await executeTool('create_customer', {
      first_name: 'Jeff', phone: '9415550100', pipeline_stage: 'churned',
    });
    expect(result).toEqual({ error: 'Invalid pipeline_stage: churned' });
    expect(db).not.toHaveBeenCalled();
  });

  test('returns the existing customer instead of creating a duplicate', async () => {
    db.mockImplementation(() => makeDuplicateLookup({
      id: 'cust-existing',
      first_name: 'Jeff',
      last_name: 'Wilson',
      phone: '(941) 705-9810',
      email: 'jwils072@fiu.edu',
      pipeline_stage: 'new_lead',
    }));

    const result = await executeTool('create_customer', {
      first_name: 'Jeff', last_name: 'Wilson', phone: '941-705-9810',
    });

    expect(result.already_exists).toBe(true);
    expect(result.customer_id).toBe('cust-existing');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('returns a no-write preview when confirmed is not true', async () => {
    db.mockImplementation(() => makeDuplicateLookup(undefined));

    const result = await executeTool('create_customer', {
      first_name: 'Jeffrey', last_name: 'Menard', phone: '(941) 524-0066',
    });

    expect(result.preview).toBe(true);
    expect(result.would_create).toMatchObject({ first_name: 'Jeffrey', state: 'FL', pipeline_stage: 'new_lead' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('creates account, customer, default rows, and tags inside one transaction', async () => {
    db.mockImplementation(() => makeDuplicateLookup(undefined));
    const calls = [];
    const trx = makeTrx(calls);
    db.transaction.mockImplementation(async (cb) => cb(trx));

    const result = await executeTool('create_customer', {
      confirmed: true,
      first_name: 'Jeffrey',
      last_name: 'Menard',
      phone: '(941) 524-0066',
      email: 'Jeffrey@NelsonPoolCompany.com',
      city: 'Lakewood Ranch',
      lead_source: 'domain_website',
      tags: ['pool-company', ''],
    });

    expect(result.success).toBe(true);
    expect(result.customer_id).toBe('cust-1');
    expect(result.customer_name).toBe('Jeffrey Menard');
    expect(result.stage).toBe('new_lead');

    const tables = calls.map(c => c.table);
    expect(tables).toEqual(expect.arrayContaining([
      'customer_accounts', 'customers', 'property_preferences', 'notification_prefs', 'customer_tags',
    ]));
    // Blank tags are dropped
    expect(calls.filter(c => c.table === 'customer_tags')).toHaveLength(1);

    const customerRow = calls.find(c => c.table === 'customers').row;
    expect(customerRow).toMatchObject({
      account_id: 'acct-1',
      is_primary_profile: true,
      profile_label: 'Primary',
      email: 'jeffrey@nelsonpoolcompany.com',
      state: 'FL',
      pipeline_stage: 'new_lead',
      lead_source: 'domain_website',
      active: true,
    });
  });
});

describe('comms read-only tool subset', () => {
  test('exposes message-history read tools and excludes writes', () => {
    const names = COMMS_READ_TOOLS.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_unanswered_threads', 'get_conversation_thread', 'search_messages',
      'get_sms_stats', 'get_call_log', 'get_todays_activity',
    ]));
    expect(names).not.toContain('send_sms');
    expect(names).not.toContain('draft_sms_reply');
    expect(names).not.toContain('get_csr_overview');
    // Every read tool is a real comms tool object, not a copy
    const all = new Set(COMMS_TOOLS.map(t => t.name));
    for (const name of names) expect(all.has(name)).toBe(true);
  });
});
