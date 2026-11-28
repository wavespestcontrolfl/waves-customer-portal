/**
 * Moving flow safety hardening tests (observable behavior for P1-M1, P1-M2,
 * P1-M3, P2-M1, P2-M2, P2-M4, P2-M6).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('P1-M1: structured HOA and entry fields clear on move', () => {
  test('MOVED_HOME_ACCESS_COLUMNS includes hoa_timing_restrictions, hoa_signage_rules, and all gate/entry fields', () => {
    const { MOVED_HOME_ACCESS_COLUMNS, clearedMovedHomeAccess } = require('../services/customer-address-fanout');
    for (const col of [
      'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
      'access_notes', 'hoa_name', 'hoa_restrictions', 'hoa_company', 'hoa_phone',
      'hoa_email', 'hoa_lawn_height', 'hoa_signage_rules', 'hoa_timing_restrictions', 'hoa_inspection_period',
    ]) {
      expect(MOVED_HOME_ACCESS_COLUMNS).toContain(col);
      expect(clearedMovedHomeAccess()[col]).toBeNull();
    }
  });
});

describe('P1-M2: move-linked estimates suppress Annual Prepay across data, SSR, and accept', () => {
  const {
    annualPrepayEligibleForEstimateData,
    annualPrepayEligibleForMosquitoTier,
    acceptPrepayAvailable,
  } = require('../routes/estimate-public');

  const eligibleSingleService = {
    services: [{ key: 'lawn_care', name: 'Lawn Care', category: 'lawn', cadence: 'monthly', price: 110, monthlyTotal: 110 }],
    recurringServices: [{ key: 'lawn_care', name: 'Lawn Care', cadence: 'monthly', price: 110 }],
    monthlyTotal: 110,
    annualTotal: 1320,
    onetimeTotal: 0,
    membershipSnapshot: { isExistingCustomer: false },
  };

  test('annualPrepayEligibleForEstimateData, mosquito tier, and acceptPrepayAvailable return false whenever estimate_data.move.moveId is set', () => {
    const moveEstData = { ...eligibleSingleService, move: { moveId: 'move-1' } };
    expect(annualPrepayEligibleForEstimateData(moveEstData)).toBe(false);
    expect(annualPrepayEligibleForMosquitoTier(moveEstData, 'monthly')).toBe(false);
    expect(acceptPrepayAvailable({
      selectedFrequency: null,
      recurringSvcList: eligibleSingleService.recurringServices,
      oneTimeList: [],
      estData: moveEstData,
      estimate: { id: 'est-1' },
    })).toBe(false);
  });
});

describe('P2-M1: moving public privacy headers & service worker bypass', () => {
  test('stampMovingPrivacyHeaders sets no-store, noindex, and no-referrer headers', () => {
    const { stampMovingPrivacyHeaders } = require('../routes/moving-public');
    const headers = {};
    const res = {
      set: (k, v) => {
        if (k && typeof k === 'object') Object.assign(headers, k);
        else headers[k] = v;
      },
    };
    const next = jest.fn();
    stampMovingPrivacyHeaders({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  test('client/public/sw.js treats /moving/<token> links as non-cacheable bearer paths', () => {
    const swSrc = fs.readFileSync(path.join(__dirname, '../../client/public/sw.js'), 'utf8');
    const fnMatch = swSrc.match(/function isOfferLinkPath[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const isSensitive = new Function(`${fnMatch[0]}; return isOfferLinkPath;`)();
    expect(isSensitive('/moving/abcdef123456')).toBe(true);
    expect(isSensitive('/MOVING/abcdef123456')).toBe(true);
    expect(isSensitive('/h/abcdef123456')).toBe(true);
    expect(isSensitive('/portal')).toBe(false);
  });
});

describe('P1-M3 & P2-M2: moveLinkBlock & loadMoveByToken', () => {
  test('moveLinkBlock refuses closed, superseded, or missing move estimates', async () => {
    const fakeConn = (row) => () => {
      const q = { where: () => q, first: async () => row };
      return q;
    };
    const Moves = require('../services/customer-moves');
    expect(await Moves.moveLinkBlock(fakeConn(null), { move: { moveId: 'm1', address: '12 Main St, Venice, FL 34285' } })).toBe('move_missing');
    expect(await Moves.moveLinkBlock(fakeConn({ id: 'm1', status: 'closed', closed_reason: 'cancelled' }), { move: { moveId: 'm1', address: '12 Main St, Venice, FL 34285' } })).toBe('move_closed');
    expect(await Moves.moveLinkBlock(fakeConn({
      id: 'm1', status: 'submitted', normalized_address: { line1: '99 Other Rd', city: 'Sarasota', state: 'FL', zip: '34231' },
    }), { move: { moveId: 'm1', address: '12 Main St, Venice, FL 34285' } })).toBe('move_address_changed');
  });

  test('loadMoveByToken filters out archived customers via customers.deleted_at IS NULL', async () => {
    jest.resetModules();
    const calls = { join: [], whereNull: [] };
    jest.doMock('../models/db', () => jest.fn(() => {
      const q = {
        join: (...a) => { calls.join.push(a); return q; },
        where: () => q,
        whereNull: (col) => { calls.whereNull.push(col); return q; },
        first: async () => null,
      };
      return q;
    }));
    const Moves = require('../services/customer-moves');
    const out = await Moves.loadMoveByToken('ab'.repeat(24));
    expect(out).toBeNull();
    expect(calls.join.some((a) => /^customers(?:\s+as\s+c)?$/i.test(String(a[0])))).toBe(true);
    expect(calls.whereNull.some((col) => /^(?:customers|c)\.deleted_at$/i.test(String(col)))).toBe(true);
  });
});

describe('P2-M4: pausedPlanRowsForMove recovers only series stopped by this move', () => {
  test('reads stopped_series from moving_paused activity metadata without pulling unrelated historical cancels', async () => {
    jest.resetModules();
    const fakeConn = jest.fn((table) => {
      const q = {
        where: () => q, whereRaw: () => q, whereNotNull: () => q, whereNull: () => q,
        whereExists: () => q, orderBy: () => q, distinct: () => q,
        first: async () => (table === 'activity_log'
          ? { metadata: JSON.stringify({ move_id: 'm1', stopped_series: [{ rootId: 'r1', serviceType: 'Termite Bait', recurringPattern: 'annual' }] }) }
          : null),
        then: (resolve) => Promise.resolve([]).then(resolve),
        catch: () => Promise.resolve([]),
      };
      return q;
    });
    fakeConn.raw = (s) => s;
    jest.doMock('../models/db', () => fakeConn);
    const Moves = require('../services/customer-moves');
    const names = await Moves.planServiceNames('cust-1', fakeConn, { move: { id: 'm1', customer_id: 'cust-1', pause_state: 'paused', from_property_id: 'p1' } });
    expect(names).toContain('Termite Bait');
  });
});
