/**
 * PR #4405 Codex round 4 — the counts kept rising (8→7→9→10) because every
 * round fixed the surface Codex named and the next round named another
 * surface with the SAME bug class: a stored line-discount slot rebuilt from
 * type+amount WITHOUT its max_discount_dollars cap replays a capped
 * percentage uncapped. `reconstructStoredLineSlot` is the shared helper that
 * gets this right; these are two more call sites that built the slot raw
 * instead of going through it.
 *
 * 1. storedAddonFor's query (the preserved-add-on lookup in the multi-line
 *    `addons` save) did not select discount_dollars, yet the code passes
 *    `stored?.discount_dollars` into reconstructStoredLineSlot as the
 *    frozen-dollar fallback. With the column missing, ANY add-on whose
 *    catalog cap can't be reconfirmed (deleted preset, drifted catalog
 *    type/amount) got `storedDollars: undefined` — reconstructStoredLineSlot
 *    then returns null (no confirmed cap AND no frozen fallback), and the
 *    surrounding code's `if (preservedSlot) {...} else { net =
 *    applyDiscount(...) }` falls to the `else` branch: a raw, UNCAPPED
 *    replay of the stored percentage. A stored 50%-off capped at $20 took
 *    $50 off a $100 add-on instead of the frozen $20.
 *
 * 2. propagatePriceServiceToFollowingSiblings' per-sibling restack (added to
 *    fix r3's "copy the edited visit's frozen dollars misbills every
 *    sibling" bug) built `primaryLineDiscount` as a bare
 *    { discountType, discountAmount } with no maxDiscountDollars — so
 *    restacking a capped primary percentage on a DIFFERENT sibling's gross
 *    reproduced the exact same uncapped-replay bug the shared helper exists
 *    to prevent, on every 'following'-scoped price/service edit to a series
 *    carrying a capped line discount.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const adminScheduleRouter = require('../routes/admin-schedule');
const {
  reconstructStoredLineSlot,
  propagatePriceServiceToFollowingSiblings,
} = adminScheduleRouter._test;
const { stackDiscounts } = require('../services/discount-stack');
const { applyDiscount } = require('../services/booking/visit-financial-stamps');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

function fakeConn(row) {
  return () => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
}

describe('finding 1 — storedAddonFor must select discount_dollars (r4 P1)', () => {
  // Reproduces the exact surrounding logic in the multi-line addons save
  // (admin-schedule.js update-details): reconstructStoredLineSlot feeds an
  // if(preservedSlot){capped}else{raw applyDiscount} branch. This isolates
  // the consequence of the missing column without standing up the whole
  // HTTP route.
  async function replayPreservedAddon({ gross, lineType, lineAmount, storedDollars }) {
    const preservedSlot = await reconstructStoredLineSlot({
      stacking: true,
      discountId: 'retired-or-drifted-promo',
      storedType: lineType,
      storedAmount: lineAmount,
      storedDollars,
      // The catalog row is gone (deleted preset) — the cap can never be
      // reconfirmed, so the fallback path is the only source of truth.
      conn: fakeConn(null),
    });
    if (preservedSlot) {
      const dollars = stackDiscounts(gross, [{
        discountType: preservedSlot.discountType,
        amount: preservedSlot.discountAmount,
        maxDiscountDollars: preservedSlot.maxDiscountDollars ?? null,
      }], { compound: true }).totalDollars;
      return Math.max(0, Math.round((gross - dollars) * 100) / 100);
    }
    return applyDiscount(gross, lineType, lineAmount);
  }

  test('discount_dollars MISSING from the row (pre-fix select): a 50%-off capped at $20 replays UNCAPPED, taking $50', async () => {
    const net = await replayPreservedAddon({
      gross: 100, lineType: 'percentage', lineAmount: 50,
      storedDollars: undefined, // exactly what `stored?.discount_dollars` was before the select fix
    });
    expect(net).toBe(50); // uncapped: 50% of $100
  });

  test('discount_dollars PRESENT on the row (post-fix select): the same preset falls back to the frozen $20, not $50', async () => {
    const net = await replayPreservedAddon({
      gross: 100, lineType: 'percentage', lineAmount: 50,
      storedDollars: 20, // the frozen amount the row actually carries once selected
    });
    expect(net).toBe(80); // $100 - frozen $20
  });

  test('wiring: the preserved-add-on query selects discount_dollars alongside discount_id/type/amount/base_price', () => {
    const block = src.slice(
      src.indexOf('const existingAddonRows = stacking && addons.some'),
      src.indexOf('const storedAddonFor ='),
    );
    const select = block.match(/\.select\(([^)]*)\)/);
    expect(select).not.toBeNull();
    expect(select[1]).toMatch(/'discount_id'/);
    expect(select[1]).toMatch(/'discount_type'/);
    expect(select[1]).toMatch(/'discount_amount'/);
    expect(select[1]).toMatch(/'discount_dollars'/);
    expect(select[1]).toMatch(/'base_price'/);
  });
});

describe('finding 2 — propagatePriceServiceToFollowingSiblings restacks the primary AND add-on slots WITH their caps (r4 P1)', () => {
  const COLS = {
    service_type: {}, service_id: {}, service_key_snapshot: {}, service_category_snapshot: {},
    is_callback: {}, appointment_type: {},
    estimated_price: {}, primary_line_price: {},
    discount_type: {}, discount_amount: {}, discount_dollars: {},
    discount_id: {}, discount_name: {},
    discount_service_key_filter: {}, discount_service_category_filter: {}, discount_max_dollars: {},
    line_discount_id: {}, line_discount_name: {}, line_discount_type: {},
    line_discount_amount: {}, line_discount_dollars: {},
  };

  // Same scriptable fake knex connection as edit-appt-price-service-scope
  // .test.js, extended with a `discounts` table so
  // reconstructStoredLineSlot's catalog re-read has somewhere to land.
  function makeConn(handler) {
    const make = () => {
      const fn = (table) => {
        const calls = [];
        const b = {};
        const record = (name) => (...args) => { calls.push([name, ...args]); return b; };
        for (const m of ['where', 'orWhere', 'whereIn', 'whereNot', 'whereNotIn', 'orderBy', 'select', 'limit', 'forUpdate']) {
          b[m] = record(m);
        }
        b.first = (...args) => {
          calls.push(['first', ...args]);
          return Promise.resolve(handler({ table, calls, op: 'first' }));
        };
        b.catch = () => b; // reconstructStoredLineSlot's catalog read chains .catch(() => null)
        b.pluck = (...args) => {
          calls.push(['pluck', ...args]);
          return Promise.resolve(handler({ table, calls, op: 'pluck' }) || []);
        };
        b.update = (data) => {
          calls.push(['update', data]);
          return { then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'update', data })).then(res, rej) };
        };
        b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await', args: calls })).then(res, rej);
        return b;
      };
      fn.transaction = (cb) => Promise.resolve().then(() => cb(make()));
      fn.schema = {
        hasTable: async (name) => name === 'scheduled_service_addons',
        hasColumn: async () => false,
      };
      fn.fn = { now: () => new Date() };
      return fn;
    };
    return make();
  }

  function scenario({ siblings, discountsById = {} }) {
    const updates = [];
    const conn = makeConn(({ table, calls, op, data }) => {
      if (op === 'await' && table === 'scheduled_services') return siblings;
      if (op === 'await' && table === 'scheduled_service_addons') return [];
      if (op === 'first' && table === 'discounts') {
        const whereCall = calls.find(([name, arg]) => name === 'where' && arg && arg.id);
        return discountsById[whereCall?.[1]?.id] || null;
      }
      if (op === 'update' && table === 'scheduled_services') {
        const whereCall = calls.find(([name, arg]) => name === 'where' && arg && arg.id);
        updates.push({ id: whereCall?.[1]?.id, data });
        return 1;
      }
      return null;
    });
    return { conn, updates };
  }

  test('a 50%-off primary line capped at $20 restacks WITH the cap on a following sibling, not uncapped at $50', async () => {
    const siblings = [
      { id: 's1', primary_line_price: '100.00', estimated_price: '80.00' },
    ];
    const { conn, updates } = scenario({
      siblings,
      discountsById: {
        'promo-cap': { discount_type: 'percentage', amount: 50, discount_key: 'promo-cap', max_discount_dollars: 20 },
      },
    });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: {
        primary_line_price: 100, estimated_price: 80,
        // The edited visit's own slot — same 50%/$20-capped preset, matching
        // catalog type/amount so the cap is confirmable.
        line_discount_id: 'promo-cap', line_discount_type: 'percentage',
        line_discount_amount: 50, line_discount_dollars: 20,
      },
      serviceChanged: false, priceChanged: true, cols: COLS,
    });
    expect(updates).toHaveLength(1);
    // Capped: $100 - $20 = $80. Pre-fix (bare type+amount, no cap) this was
    // $50 (uncapped 50% of $100), an estimated_price/line_discount_dollars
    // mismatch against the visit's own $80 total.
    expect(updates[0].data.line_discount_dollars).toBe(20);
  });

  test('a missing/retired catalog row falls back to the frozen dollars, not an unconfirmed uncapped term', async () => {
    const siblings = [
      { id: 's1', primary_line_price: '100.00', estimated_price: '80.00' },
    ];
    const { conn, updates } = scenario({
      siblings,
      discountsById: {}, // the preset no longer exists
    });
    await propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited', parentId: 'p1', fromDateStr: '2098-01-15',
      fields: {
        primary_line_price: 100, estimated_price: 80,
        line_discount_id: 'promo-cap', line_discount_type: 'percentage',
        line_discount_amount: 50, line_discount_dollars: 20,
      },
      serviceChanged: false, priceChanged: true, cols: COLS,
    });
    // Falls back to the frozen $20 the edited visit itself carried — never
    // a raw/uncapped 50% reconstruction.
    expect(updates[0].data.line_discount_dollars).toBe(20);
  });

  test('wiring: the sibling restack reconstructs the primary slot through the shared cap-aware helper, not a bare type+amount object', () => {
    const block = src.slice(
      src.indexOf('if (restackLineDiscountPerSibling) {'),
      src.indexOf('const restated = siblingStacked.lines?.[0];'),
    );
    expect(block).toMatch(/const primarySlot = await reconstructStoredLineSlot\(/);
    expect(block).toMatch(/primaryLineDiscount: primarySlot \? \{[\s\S]*?maxDiscountDollars: primarySlot\.maxDiscountDollars/);
  });
});
