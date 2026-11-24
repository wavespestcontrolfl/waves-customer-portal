/**
 * /r/:code landing (GATE_REFERRAL_FRIEND_PAGE, referral plan part 4): a member's link goes to the website's
 * friend page only while the gate is on, the live Step 2 friend credit equals the amount that page states, and
 * the code has an owner the office can confirm. In every other state it goes to the homepage, as before.
 *
 * The engine's own reader (step2FriendCreditCents) and the queue's own owner lookup (customerForCode) run for
 * real over small in-memory tables, so the route and the two rules are tested together.
 */
const state = {
  gates: {},
  settings: null,
  failingTable: null,
  promoters: [],
  customers: [],
  tables: [],
  inserts: [],
  increments: [],
};

jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (name) => (name in state.gates ? state.gates[name] : actual.isEnabled(name)) };
});

jest.mock('../models/db', () => {
  const rowsOf = (table) => {
    if (table === 'referral_program_settings') return state.settings ? [state.settings] : [];
    if (table === 'referral_promoters') return state.promoters;
    if (table === 'customers') return state.customers;
    return []; // referral_clicks: no click in the last 24 hours
  };
  const builder = (table) => {
    state.tables.push(table);
    const tests = [];
    const b = {
      // where({ col: value }) filters; the 3-argument form (a date range on referral_clicks) is not modelled.
      where: (cond) => {
        if (cond && typeof cond === 'object') tests.push((row) => Object.entries(cond).every(([k, v]) => row[k] === v));
        return b;
      },
      whereNull: (col) => { tests.push((row) => row[col] == null); return b; },
      whereNotNull: (col) => { tests.push((row) => row[col] != null); return b; },
      first: async () => {
        if (state.failingTable === table) throw new Error(`${table} cannot be read`);
        return rowsOf(table).find((row) => tests.every((t) => t(row))) || null;
      },
      insert: async (row) => { state.inserts.push(row); return [1]; },
      increment: async (cols) => { state.increments.push(cols); return 1; },
    };
    return b;
  };
  const db = jest.fn(builder);
  db.raw = (sql) => sql;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const router = require('../routes/referral-links');

const CODE = 'WAVES-TEST01';
const HOME = `https://wavespestcontrol.com/?ref=${CODE}&utm_source=referral`;
const FRIEND_PAGE = `https://wavespestcontrol.com/referrer/?ref=${CODE}&utm_source=referral`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PREVIEW_BOT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/r', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const click = async (code = CODE, ua = IPHONE) => {
  const res = await fetch(`${baseUrl}/r/${code}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { status: res.status, location: res.headers.get('location') };
};

// Step 2 live and paying what the friend page states: both gates on, an active program, $50.
const liveStep2 = () => {
  state.gates = { referralFriendPage: true, referralStep2: true };
  state.settings = { id: 1, program_active: true, referee_discount_cents: 5000 };
};
const member = () => state.customers[0];
const promoter = () => state.promoters[0];

beforeEach(() => {
  state.gates = { referralFriendPage: false, referralStep2: false };
  state.settings = { id: 1, program_active: true, referee_discount_cents: 2500 };
  state.failingTable = null;
  // A member with an active promoter row that owns the code.
  state.customers = [{ id: 'customer-1', referral_code: null, deleted_at: null }];
  state.promoters = [{ id: 1, referral_code: CODE, status: 'active', customer_id: 'customer-1', merged_into_promoter_id: null }];
  state.tables.length = 0;
  state.inserts.length = 0;
  state.increments.length = 0;
});

test('the page states $50', () => {
  expect(router._FRIEND_PAGE).toEqual({ path: '/referrer/', statesFriendCreditCents: 5000 });
});

describe('gate off (production today)', () => {
  test('a member link goes to the homepage, with no settings read and no owner lookup', async () => {
    const res = await click();
    expect(res).toEqual({ status: 302, location: HOME });
    // The route's own reads only: the promoter, the recent click, the click row, the click count.
    expect(state.tables).toEqual(['referral_promoters', 'referral_clicks', 'referral_clicks', 'referral_promoters']);
    expect(state.inserts).toHaveLength(1);
    expect(state.increments).toEqual([{ total_clicks: 1 }]);
  });

  test('the same with Step 2 live and paying $50: the link waits for its own gate', async () => {
    liveStep2();
    state.gates.referralFriendPage = false;
    expect((await click()).location).toBe(HOME);
    expect(state.tables).not.toContain('referral_program_settings');
  });
});

describe('gate on', () => {
  test('Step 2 pays what the page states and the code has a live owner: the friend page, with the code', async () => {
    liveStep2();
    expect(await click()).toEqual({ status: 302, location: FRIEND_PAGE });
  });

  test('the click is recorded and counted exactly as before', async () => {
    liveStep2();
    await click();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ promoter_id: 1, referral_code: CODE, is_unique: true, device_type: 'mobile' });
    expect(state.increments).toEqual([{ total_clicks: 1 }]);
  });

  test('a link preview goes to the friend page too, as a bot row that is not counted', async () => {
    liveStep2();
    const res = await click(CODE, PREVIEW_BOT);
    expect(res.location).toBe(FRIEND_PAGE);
    expect(state.inserts[0]).toMatchObject({ is_unique: false, device_type: 'bot' });
    expect(state.increments).toEqual([]);
  });

  test('a code of a promoter merged into another: the friend page, by the surviving promoter\'s member', async () => {
    liveStep2();
    state.promoters = [
      { id: 1, referral_code: CODE, status: 'merged', customer_id: 'customer-old', merged_into_promoter_id: 2 },
      { id: 2, referral_code: 'WAVES-KEPT01', status: 'active', customer_id: 'customer-1', merged_into_promoter_id: null },
    ];
    expect((await click()).location).toBe(FRIEND_PAGE);
    expect(state.inserts[0]).toMatchObject({ promoter_id: 2 });
  });

  test('a code that lives only on a live customer row: the friend page, and no click row', async () => {
    liveStep2();
    state.promoters = [];
    member().referral_code = CODE;
    expect((await click()).location).toBe(FRIEND_PAGE);
    expect(state.inserts).toHaveLength(0);
  });

  describe('the homepage, with the code, and the click still recorded', () => {
    test.each([
      ['Step 2 is off', () => { state.gates.referralStep2 = false; }],
      ['the program is paused', () => { state.settings.program_active = false; }],
      ['the setting pays less than the page states', () => { state.settings.referee_discount_cents = 2500; }],
      ['the setting pays more than the page states', () => { state.settings.referee_discount_cents = 7500; }],
      ['the setting has no amount', () => { state.settings.referee_discount_cents = null; }],
      ['there is no settings row', () => { state.settings = null; }],
      ['the settings row cannot be read', () => { state.failingTable = 'referral_program_settings'; }],
      ['the member is archived', () => { member().deleted_at = new Date(); }],
      ['the promoter has no customer', () => { promoter().customer_id = null; }],
      ['the owner lookup fails', () => { state.failingTable = 'customers'; }],
    ])('%s', async (_name, arrange) => {
      liveStep2();
      arrange();
      expect(await click()).toEqual({ status: 302, location: HOME });
      expect(state.inserts).toHaveLength(1);
      expect(state.increments).toEqual([{ total_clicks: 1 }]);
    });
  });

  test('a code that lives only on an archived customer row: the homepage with the code, as before', async () => {
    liveStep2();
    state.promoters = [];
    Object.assign(member(), { referral_code: CODE, deleted_at: new Date() });
    expect((await click()).location).toBe(HOME);
    expect(state.inserts).toHaveLength(0);
  });

  test('an unknown code goes home with no code, and the settings row is not read', async () => {
    liveStep2();
    state.promoters = [];
    expect((await click()).location).toBe('https://wavespestcontrol.com');
    expect(state.tables).not.toContain('referral_program_settings');
    expect(state.inserts).toHaveLength(0);
  });

  test('a malformed code goes home before any read', async () => {
    liveStep2();
    expect((await click('a%20b')).location).toBe('https://wavespestcontrol.com');
    expect(state.tables).toEqual([]);
  });
});
