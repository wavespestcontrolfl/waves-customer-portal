// The bell's No bid / Bid buttons on a new bid invite's row (services/bid-desk/alert-buttons.js, kind bid_decision,
// GATE_BID_ALERT_BUTTONS): what the row stores, which buttons the bell serves for the bid as it stands, and how a tap
// runs the Bid desk's own save step. The save step itself and a real tap run through PostgreSQL in
// bid-desk.db.test.js; the runner (claim, record, close) is admin-alert-buttons.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ bidAlertButtonsLive: jest.fn(() => true), bidDeskLive: jest.fn(() => true) }));
jest.mock('../routes/admin-bid-desk', () => ({ saveBidUpdate: jest.fn() }));

let mockBids = [];
const mockQueries = [];
const mockTrx = { trx: true };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {
      whereIn: jest.fn((col, ids) => { mockQueries.push({ table, col, ids }); return q; }),
      select: jest.fn(async () => mockBids),
    };
    return q;
  });
  db.transaction = jest.fn(async (fn) => fn(mockTrx));
  return db;
});

const gates = require('../config/feature-gates');
const { saveBidUpdate } = require('../routes/admin-bid-desk');
const { buttonViolations, composeAdminAlert } = require('../services/admin-alert-compose');
const { bidButtons, buttonHandler, _private: { allowedFor } } = require('../services/bid-desk/alert-buttons');
const { newBidSpec } = require('../services/bid-desk/alerts');

const B1 = '00000000-0000-4000-8000-00000000b1d1';
const B2 = '00000000-0000-4000-8000-00000000b1d2';
const DUE = new Date('2026-11-20T21:00:00Z');
const bid = (over = {}) => ({ id: B1, status: 'new', due_at: DUE, due_confirmed: true, needs_date_confirmation: false, ...over });
const row = (over = {}) => ({ id: 'n1', metadata: { bidId: B1, buttons: bidButtons() }, ...over });
const tap = (itemId, over = {}) => buttonHandler.run({ row: row(over), item: { id: itemId }, technicianId: 't-1' });

beforeEach(() => {
  jest.clearAllMocks();
  mockBids = [];
  mockQueries.length = 0;
  gates.bidAlertButtonsLive.mockReturnValue(true);
  gates.bidDeskLive.mockReturnValue(true);
});

test('a new bid invite\'s row stores both buttons, within the button rules', () => {
  expect(buttonViolations(bidButtons())).toEqual([]);
  const { spec } = newBidSpec({ id: B1, project_title: 'Sample Ridge Residences', gc_or_agency: 'Fixture Build Co', due_at: null }, null);
  expect(composeAdminAlert(spec).metadata.buttons).toEqual(bidButtons());
  expect(bidButtons().items.map((item) => item.label)).toEqual(['No bid', 'Bid']);
});

test.each([
  ['a new bid with a confirmed due date', bid(), ['no_bid', 'bid']],
  ['a new bid whose date was never confirmed', bid({ due_confirmed: false }), ['no_bid']],
  ['a new bid with no due date', bid({ due_at: null, due_confirmed: false }), ['no_bid']],
  ['a confirmed date an addendum put in question', bid({ needs_date_confirmation: true }), ['no_bid']],
  ['a bid already marked Bid', bid({ status: 'bid' }), []],
  ['a bid marked No bid', bid({ status: 'no_bid' }), []],
  ['a bid that is gone', undefined, []],
])('%s serves %j', (_name, record, ids) => {
  expect(allowedFor(record)).toEqual(ids);
});

describe('serving the bell (visibleItems)', () => {
  test('one read for every bid row on the page; each row gets its own bid\'s buttons', async () => {
    mockBids = [bid(), bid({ id: B2, due_confirmed: false })];
    const allowed = await buttonHandler.visibleItems([
      { id: 'n1', metadata: { bidId: B1 } },
      { id: 'n2', metadata: { bidId: B2 } },
      { id: 'n3', metadata: { bidId: 'not-a-bid-id' } },
      { id: 'n4', metadata: { bidId: B1 } },
    ]);
    expect(mockQueries).toEqual([{ table: 'bid_opportunities', col: 'id', ids: [B1, B2] }]);
    expect(Object.fromEntries(allowed)).toEqual({ n1: ['no_bid', 'bid'], n2: ['no_bid'], n3: [], n4: ['no_bid', 'bid'] });
  });

  test('no bid ids, no read', async () => {
    const allowed = await buttonHandler.visibleItems([{ id: 'n1', metadata: {} }]);
    expect(mockQueries).toEqual([]);
    expect(allowed.get('n1')).toEqual([]);
  });
});

describe('a tap (run)', () => {
  const precheckOf = () => saveBidUpdate.mock.calls[0][3].precheck;

  test('No bid runs the Bid desk\'s save step with that status, in one transaction', async () => {
    saveBidUpdate.mockResolvedValue({ status: 200, body: { ok: true } });
    await expect(tap('no_bid')).resolves.toEqual({ ok: true, message: 'Marked No bid.', resolution: 'No bid' });
    expect(saveBidUpdate).toHaveBeenCalledWith(mockTrx, B1, { status: 'no_bid' }, { precheck: expect.any(Function) });
  });

  test('Bid runs the same step with status bid', async () => {
    saveBidUpdate.mockResolvedValue({ status: 200, body: { ok: true } });
    await expect(tap('bid')).resolves.toEqual({ ok: true, message: 'Marked Bid.', resolution: 'Bid' });
    expect(saveBidUpdate.mock.calls[0][2]).toEqual({ status: 'bid' });
  });

  test('under the save step\'s lock: a decided bid is refused, and Bid needs a confirmed due date', async () => {
    saveBidUpdate.mockResolvedValue({ status: 200, body: { ok: true } });
    await tap('bid');
    const forBid = precheckOf();
    expect(forBid(bid())).toBeNull();
    expect(forBid(bid({ due_confirmed: false }))).toEqual({ status: 409, body: { error: 'date_not_confirmed' } });
    expect(forBid(bid({ needs_date_confirmation: true }))).toEqual({ status: 409, body: { error: 'date_not_confirmed' } });
    expect(forBid(bid({ status: 'no_bid' }))).toEqual({ status: 409, body: { error: 'decided' } });
    saveBidUpdate.mockClear();
    await tap('no_bid');
    const forNoBid = precheckOf();
    expect(forNoBid(bid({ due_at: null, due_confirmed: false }))).toBeNull();
    expect(forNoBid(bid({ status: 'bid' }))).toEqual({ status: 409, body: { error: 'decided' } });
  });

  test.each([
    ['decided elsewhere: the row closes with that note', { status: 409, body: { error: 'decided' } },
      { ok: false, code: 'decided', message: 'This bid was already decided on the Bid desk.', close: 'Bid already decided on the Bid desk' }],
    ['the date is not confirmed: the row stays open', { status: 409, body: { error: 'date_not_confirmed' } },
      { ok: false, code: 'date_not_confirmed', message: 'Confirm the due date on the Bid desk first.' }],
    ['the bid is gone: the row closes', { status: 404, body: { error: 'Not found' } },
      { ok: false, code: 'gone', message: 'This bid is no longer on the Bid desk.', close: 'Bid no longer on the Bid desk' }],
    ['any other refusal of the save step: the row stays open', { status: 409, body: { error: 'This bid changed since you opened it' } },
      { ok: false, code: 'refused', message: 'Open the Bid desk to save this decision.' }],
  ])('%s', async (_name, outcome, answer) => {
    saveBidUpdate.mockResolvedValue(outcome);
    await expect(tap('bid')).resolves.toEqual(answer);
  });

  test('a button it does not know, or a row with no bid id, saves nothing', async () => {
    await expect(tap('won')).resolves.toMatchObject({ ok: false, code: 'unknown_action' });
    await expect(tap('no_bid', { metadata: JSON.stringify({ bidId: 'nope' }) })).resolves.toMatchObject({ ok: false, code: 'refused' });
    expect(saveBidUpdate).not.toHaveBeenCalled();
  });

  test('a string metadata column is read the same way', async () => {
    saveBidUpdate.mockResolvedValue({ status: 200, body: { ok: true } });
    await expect(tap('no_bid', { metadata: JSON.stringify({ bidId: B1 }) })).resolves.toMatchObject({ ok: true });
    expect(saveBidUpdate.mock.calls[0][1]).toBe(B1);
  });
});

test.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
])('buttons gate %s and Bid desk gate %s: live %s', (buttonsOn, deskOn, live) => {
  gates.bidAlertButtonsLive.mockReturnValue(buttonsOn);
  gates.bidDeskLive.mockReturnValue(deskOn);
  expect(buttonHandler.live()).toBe(live);
});
