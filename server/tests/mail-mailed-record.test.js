/**
 * services/mail/mailed-record.js, the parts that need no database: the frozen snapshot, the printed price of a mailed row,
 * the hold date (60 days, Eastern), the label price and name, and the office line of a home.
 */

jest.mock('../models/db', () => jest.fn());

const {
  snapshotOf, printedPriceOf, heldUntilOf, heldUntilLabel, labelPrice, perApplicationLabel, labelName, officeLineOf, markBatch, PRICE_HOLD_DAYS,
} = require('../services/mail/mailed-record');

describe('snapshotOf', () => {
  test('keeps dollars as numbers and the monthly price from whole cents', () => {
    expect(snapshotOf({ price_annual: '601.02', price_setup_fee: '25.00', priced_at: new Date('2026-11-22T22:00:00Z') }))
      .toEqual({ plan: 'pest_quarterly', annual: 601.02, monthly: 50.09, setupFee: 25, pricedAt: '2026-11-22T22:00:00.000Z' });
  });
  test('no amount, no snapshot', () => {
    expect(snapshotOf({ price_annual: null, price_setup_fee: '0' })).toBeNull();
    expect(snapshotOf({ price_annual: '500', price_setup_fee: null })).toBeNull();
  });
});

describe('printedPriceOf', () => {
  const snap = { plan: 'pest_quarterly', annual: 600, monthly: 50, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' };
  test('only a mailed row has one; a text snapshot is read', () => {
    expect(printedPriceOf({ mailed_at: null, mailed_price: snap })).toBeNull();
    expect(printedPriceOf({ mailed_at: new Date(), mailed_price: snap })).toEqual({ monthly: 50, annual: 600, setupFee: 0, pricedAt: snap.pricedAt });
    expect(printedPriceOf({ mailed_at: new Date(), mailed_price: JSON.stringify(snap) })).toMatchObject({ monthly: 50 });
  });
  test('a snapshot without its numbers, or text that is not JSON, is no price', () => {
    expect(printedPriceOf({ mailed_at: new Date(), mailed_price: { plan: 'x' } })).toBeNull();
    expect(printedPriceOf({ mailed_at: new Date(), mailed_price: '{nope' })).toBeNull();
    expect(printedPriceOf({ mailed_at: new Date(), mailed_price: null })).toBeNull();
  });
});

describe('the hold date', () => {
  test('60 days after the Eastern day of marking', () => {
    expect(PRICE_HOLD_DAYS).toBe(60);
    expect(heldUntilOf(new Date('2026-11-24T15:00:00Z'))).toBe('2027-01-23');
    // 02:00 UTC on Nov 25 is still the evening of Nov 24 in Eastern time.
    expect(heldUntilOf(new Date('2026-11-25T02:00:00Z'))).toBe('2027-01-23');
    expect(heldUntilOf(null)).toBeNull();
    expect(heldUntilOf('not a date')).toBeNull();
  });
  test('the label wording is "Mon D"', () => {
    expect(heldUntilLabel('2027-01-23')).toBe('Jan 23');
    expect(heldUntilLabel('2027-12-05')).toBe('Dec 5');
    expect(heldUntilLabel(null)).toBeNull();
  });
});

describe('label price and name', () => {
  test('whole dollars bare, else two decimals (as the page prints the monthly price)', () => {
    expect(labelPrice(42)).toBe('42');
    expect(labelPrice(41.5)).toBe('41.50');
    expect(labelPrice(50.09)).toBe('50.09');
  });
  test('the price of one application is annual / 4 from whole cents', () => {
    expect(perApplicationLabel(600)).toBe('150');
    expect(perApplicationLabel('601.02')).toBe('150.26');
    expect(perApplicationLabel(450)).toBe('112.50');
  });
  test('buyers as "LAST FIRST M": one name, one family, two families', () => {
    expect(labelName(['TESTER ALEX J'])).toEqual({ name: 'Alex Tester', check: false });
    expect(labelName(['TESTER ALEX J', 'TESTER JAMIE'])).toEqual({ name: 'Alex & Jamie Tester', check: false });
    expect(labelName(['TESTER ALEX', 'SAMPLE SAM'])).toEqual({ name: 'Alex Tester & Sam Sample', check: false });
  });
  test('a name that is not that shape is listed as written and flagged for a look', () => {
    expect(labelName(['TESTER ALEX JR'])).toEqual({ name: 'Tester Alex Jr', check: true });
    expect(labelName(['TESTER-SMITH ALEX'])).toMatchObject({ check: true });
    expect(labelName([])).toEqual({ name: '', check: true });
  });
});

describe('officeLineOf', () => {
  test('the office of the home\'s city, or of its ZIP when the city names none', () => {
    expect(officeLineOf({ city: 'LAKEWOOD RANCH', zip: '34202' })).toEqual({ number: '(941) 318-7612', byDefault: false });
    expect(officeLineOf({ city: 'PARRISH', zip: '34219' })).toEqual({ number: '(941) 297-2817', byDefault: false });
    expect(officeLineOf({ city: 'NORTH PORT', zip: '34286' })).toEqual({ number: '(941) 297-3337', byDefault: false });
    expect(officeLineOf({ city: 'SAMPLETON', zip: '34236' })).toMatchObject({ byDefault: false }); // ZIP 34236 is Sarasota
  });
  test('no city and no ZIP that names an office: the default line, flagged', () => {
    expect(officeLineOf({ city: 'SAMPLETON', zip: '99999' })).toEqual({ number: '(941) 318-7612', byDefault: true });
  });
});

describe('markBatch input', () => {
  test('a bad batch name or id list is refused before any database call', async () => {
    for (const batch of [undefined, '', '-x', 'a b', 'x'.repeat(41)]) await expect(markBatch({ batch })).rejects.toThrow(TypeError);
    await expect(markBatch({ batch: 'ok', ids: [] })).rejects.toThrow(TypeError);
    await expect(markBatch({ batch: 'ok', ids: ['nope'] })).rejects.toThrow(TypeError);
  });

  test('printedPriceOf passes pricedAt only as an ISO time', () => {
    const base = { mailed_at: new Date('2026-11-24T15:00:00Z') };
    const snap = (pricedAt) => ({ ...base, mailed_price: { plan: 'pest_quarterly', annual: 600, monthly: 50, setupFee: 0, pricedAt } });
    expect(printedPriceOf(snap('2026-11-22T22:00:00Z')).pricedAt).toBe('2026-11-22T22:00:00.000Z');
    expect(printedPriceOf(snap({ evil: 1 })).pricedAt).toBeNull();
    expect(printedPriceOf(snap('not a date')).pricedAt).toBeNull();
    expect(printedPriceOf(snap(12345)).pricedAt).toBeNull();
  });
});

describe('the label fields kept with the price', () => {
  const { printedLabelOf, labelFieldsOf } = require('../services/mail/mailed-record');
  const row = { recipient_names: ['TESTER ALEX J', 'TESTER JAMIE'], city: 'LAKEWOOD RANCH', zip: '34202' };
  test('labelFieldsOf: the name and the office line', () => {
    expect(labelFieldsOf(row)).toEqual({ name: 'Alex & Jamie Tester', nameCheck: false, textNumber: expect.any(String), officeByDefault: false });
  });
  test('printedLabelOf: only a mailed row with whole fields; an older snapshot has none', () => {
    const label = labelFieldsOf(row);
    const snap = { plan: 'pest_quarterly', annual: 600, monthly: 50, setupFee: 0, pricedAt: null, label };
    expect(printedLabelOf({ mailed_at: new Date(), mailed_price: snap })).toEqual(label);
    expect(printedLabelOf({ mailed_at: new Date(), mailed_price: JSON.stringify(snap) })).toEqual(label);
    expect(printedLabelOf({ mailed_at: null, mailed_price: snap })).toBeNull();
    expect(printedLabelOf({ mailed_at: new Date(), mailed_price: { ...snap, label: undefined } })).toBeNull();
    expect(printedLabelOf({ mailed_at: new Date(), mailed_price: { ...snap, label: { name: 'A', textNumber: '' } } })).toBeNull();
    expect(printedLabelOf({ mailed_at: new Date(), mailed_price: '{nope' })).toBeNull();
  });
});

describe('knownToWavesNow', () => {
  const home = { address_line1: '101 EXAMPLE TRL', city: 'LAKEWOOD RANCH', state: 'FL', zip: '34202' };
  const load = (known, member) => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    const addressKnownToWaves = jest.fn(async () => known);
    const memberStatusOf = typeof member === 'function' ? jest.fn(member) : jest.fn(async () => member);
    jest.doMock('../services/mail/prospect-store', () => ({ addressKnownToWaves }));
    jest.doMock('../services/mail/home-quote', () => ({ memberStatusOf, memberAtAddressOn: (conn) => ({ on: conn }) }));
    return { ...require('../services/mail/mailed-record'), addressKnownToWaves, memberStatusOf };
  };
  afterEach(() => { jest.dontMock('../services/mail/prospect-store'); jest.dontMock('../services/mail/home-quote'); jest.resetModules(); });

  test('a customers row at the address, or a member at or near it, is known; both checks run on the given connection', async () => {
    const conn = { trx: 1 };
    const stranger = load(false, null);
    expect(await stranger.knownToWavesNow(home, conn)).toBe(false);
    expect(stranger.addressKnownToWaves).toHaveBeenCalledWith('101 EXAMPLE TRL', '34202', conn);
    expect(stranger.memberStatusOf).toHaveBeenCalledWith(home, { on: conn });
    expect(await load(true, null).knownToWavesNow(home, conn)).toBe(true);
    expect(await load(false, 'exact').knownToWavesNow(home, conn)).toBe(true);
    expect(await load(false, 'near').knownToWavesNow(home, conn)).toBe(true);
  });
  test('a check that cannot finish throws: it never reads as a stranger', async () => {
    await expect(load(false, async () => { throw new Error('lookup down'); }).knownToWavesNow(home, {})).rejects.toThrow('lookup down');
  });
});
