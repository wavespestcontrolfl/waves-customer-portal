/**
 * /r/:code landing (GATE_REFERRAL_FRIEND_PAGE, referral plan part 4): a member's link goes to the website's
 * friend page only while the gate is on AND the live Step 2 friend credit equals the amount that page states.
 * In every other state it goes to the homepage, as before. The engine's own reader (step2FriendCreditCents)
 * runs for real over a fake settings row, so the route and the reader are tested together.
 */
const state = {
  gates: {},
  settings: null,
  settingsThrows: false,
  promoter: null,
  legacyCustomer: null,
  tables: [],
  inserts: [],
  increments: [],
};

jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (name) => (name in state.gates ? state.gates[name] : actual.isEnabled(name)) };
});

jest.mock('../models/db', () => {
  const builder = (table) => {
    state.tables.push(table);
    const b = {
      where: () => b,
      whereNotNull: () => b,
      first: async () => {
        if (table === 'referral_program_settings') {
          if (state.settingsThrows) throw new Error('settings row cannot be read');
          return state.settings;
        }
        if (table === 'referral_promoters') return state.promoter;
        if (table === 'customers') return state.legacyCustomer;
        return null; // referral_clicks: no click in the last 24 hours
      },
      insert: async (row) => { state.inserts.push(row); return [1]; },
      increment: async (cols) => { state.increments.push(cols); return 1; },
    };
    return b;
  };
  return jest.fn(builder);
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

beforeEach(() => {
  state.gates = { referralFriendPage: false, referralStep2: false };
  state.settings = { id: 1, program_active: true, referee_discount_cents: 2500 };
  state.settingsThrows = false;
  state.promoter = { id: 'promoter-1', referral_code: CODE, status: 'active' };
  state.legacyCustomer = null;
  state.tables.length = 0;
  state.inserts.length = 0;
  state.increments.length = 0;
});

test('the page states $50', () => {
  expect(router._FRIEND_PAGE).toEqual({ path: '/referrer/', statesFriendCreditCents: 5000 });
});

describe('gate off (production today)', () => {
  test('a member link goes to the homepage, and the settings row is not read', async () => {
    const res = await click();
    expect(res).toEqual({ status: 302, location: HOME });
    expect(state.tables).not.toContain('referral_program_settings');
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
  test('Step 2 live and paying what the page states: the friend page, with the code', async () => {
    liveStep2();
    const res = await click();
    expect(res).toEqual({ status: 302, location: FRIEND_PAGE });
  });

  test('the click is recorded and counted exactly as before', async () => {
    liveStep2();
    await click();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ promoter_id: 'promoter-1', referral_code: CODE, is_unique: true, device_type: 'mobile' });
    expect(state.increments).toEqual([{ total_clicks: 1 }]);
  });

  test('a link preview goes to the friend page too, as a bot row that is not counted', async () => {
    liveStep2();
    const res = await click(CODE, PREVIEW_BOT);
    expect(res.location).toBe(FRIEND_PAGE);
    expect(state.inserts[0]).toMatchObject({ is_unique: false, device_type: 'bot' });
    expect(state.increments).toEqual([]);
  });

  test('a code that lives only on the customer row: the friend page, and no click row', async () => {
    liveStep2();
    state.promoter = null;
    state.legacyCustomer = { id: 'customer-1', referral_code: CODE };
    const res = await click();
    expect(res.location).toBe(FRIEND_PAGE);
    expect(state.inserts).toHaveLength(0);
  });

  test.each([
    ['Step 2 is off', () => { state.gates.referralStep2 = false; }],
    ['the program is paused', () => { state.settings.program_active = false; }],
    ['the setting pays less than the page states', () => { state.settings.referee_discount_cents = 2500; }],
    ['the setting pays more than the page states', () => { state.settings.referee_discount_cents = 7500; }],
    ['the setting has no amount', () => { state.settings.referee_discount_cents = null; }],
    ['there is no settings row', () => { state.settings = null; }],
    ['the settings row cannot be read', () => { state.settingsThrows = true; }],
  ])('%s: the homepage, with the code, and the click still recorded', async (_name, arrange) => {
    liveStep2();
    arrange();
    const res = await click();
    expect(res).toEqual({ status: 302, location: HOME });
    expect(state.inserts).toHaveLength(1);
    expect(state.increments).toEqual([{ total_clicks: 1 }]);
  });

  test('an unknown code goes home with no code, and the settings row is not read', async () => {
    liveStep2();
    state.promoter = null;
    const res = await click();
    expect(res.location).toBe('https://wavespestcontrol.com');
    expect(state.tables).not.toContain('referral_program_settings');
    expect(state.inserts).toHaveLength(0);
  });

  test('a malformed code goes home before any read', async () => {
    liveStep2();
    const res = await click('a%20b');
    expect(res.location).toBe('https://wavespestcontrol.com');
    expect(state.tables).toEqual([]);
  });
});
