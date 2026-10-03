/**
 * pairCustomersAtSameAddress is linear in the rows: it buckets by the
 * comparator's own premise key and only confirms pairs inside a bucket. Pins
 * (1) bucket membership can never disagree with sameStreetAddress (property-style
 * over varied spellings, against brute force), and (2) the comparator call count
 * for large same-house-number buildings. Synthetic addresses only.
 */
jest.mock('../services/estimator-engine/address-compare', () => {
  const actual = jest.requireActual('../services/estimator-engine/address-compare');
  return { ...actual, sameStreetAddress: jest.fn((...args) => actual.sameStreetAddress(...args)) };
});

const compare = require('../services/estimator-engine/address-compare');
const { pairCustomersAtSameAddress, _private } = require('../services/customer-address-match');

beforeEach(() => compare.sameStreetAddress.mockClear());

const row = (customerId, address_line1, extra = {}) => ({ customerId, matchedVia: 'primary', address_line1, city: 'Sarasota', zip: '34231', ...extra });

describe('comparator work stays linear', () => {
  test('a 300-unit building with distinct units compares nothing (every unit is its own bucket)', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`c${i}`, '100 Example Loop', { address_line2: `Unit ${i + 1}` }));
    expect(pairCustomersAtSameAddress(rows)).toEqual([]);
    expect(compare.sameStreetAddress).not.toHaveBeenCalled();
  });

  test('300 rows sharing a house number on different streets compare nothing', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`c${i}`, `100 ${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyzabcd'[Math.floor(i / 100)]} Sample Street`));
    expect(pairCustomersAtSameAddress(rows)).toEqual([]);
    expect(compare.sameStreetAddress.mock.calls.length).toBeLessThanOrEqual(300);
  });

  test('150 two-customer premises inside one big building cost one comparison each', () => {
    const rows = [];
    for (let i = 0; i < 150; i += 1) {
      rows.push(row(`a${i}`, '100 Example Loop', { address_line2: `Unit ${i + 1}` }), row(`b${i}`, '100 Example Loop', { address_line2: `Apt ${i + 1}` }));
    }
    const pairs = pairCustomersAtSameAddress(rows);
    expect(pairs).toHaveLength(150);
    expect(compare.sameStreetAddress.mock.calls.length).toBe(150);
  });
});

describe('multi-unit rows need a named, equal unit (the comparator itself is unchanged)', () => {
  test('two multi-unit rows with no unit are not paired; the same unit is; one-sided is not', () => {
    expect(pairCustomersAtSameAddress([row('a', '100 Example Loop', { multiUnit: true }), row('b', '100 Example Loop', { multiUnit: true })])).toEqual([]);
    expect(pairCustomersAtSameAddress([
      row('a', '100 Example Loop', { multiUnit: true, address_line2: 'Unit 4' }), row('b', '100 Example Loop', { multiUnit: true, address_line2: 'Apt 4' }),
    ])).toHaveLength(1);
    expect(pairCustomersAtSameAddress([row('a', '100 Example Loop', { multiUnit: true, address_line2: 'Unit 4' }), row('b', '100 Example Loop', { multiUnit: true })])).toEqual([]);
  });
  test('either side multi-unit makes the pair multi-unit; neither keeps today\'s null-equals-null match', () => {
    expect(pairCustomersAtSameAddress([row('a', '100 Example Loop', { multiUnit: true }), row('b', '100 Example Loop')])).toEqual([]);
    expect(pairCustomersAtSameAddress([row('a', '100 Example Loop'), row('b', '100 Example Loop')])).toHaveLength(1);
  });
  test('sameStreetAddress still treats two unit-less addresses as the same premise for its other callers', () => {
    const { sameStreetAddress } = jest.requireActual('../services/estimator-engine/address-compare');
    expect(sameStreetAddress('100 Example Loop, Sarasota, 34231', '100 Example Loop, Sarasota, 34231', { requireExactUnit: true })).toBe(true);
  });
});

describe('bucketing never disagrees with the pairwise comparator (property-style)', () => {
  let seed = 20261003;
  // mulberry32: deterministic, full-period within 32-bit integer math.
  const rand = (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
  const pick = (list) => list[rand(list.length)];

  const streets = [
    ['Example Loop', 'Example Lp'], ['Sample Street', 'sample st', 'SAMPLE STREET.'], ['Test Avenue', 'Test Ave', 'test av'],
    ['53rd Avenue East', '53rd Ave E', '53rd Ave. East'], ['State Road 64', 'SR 64', 'State Rd 64'], ['Oak Cove', 'Oak Cv'],
    ['Quartz Court', 'quartz ct'], ['Maple Trail', 'Maple Trl'],
  ];
  const units = [null, null, null, '4', '7', '12-B'];
  const zips = ['34231', '34231-1234', '34232', null];
  const cities = ['Sarasota', 'sarasota', 'Bradenton', null];

  function randomRow(i, narrow = false) {
    const houseNumber = narrow ? 100 : pick([100, 100, 100, 101, 2210]);
    const street = narrow ? pick(streets.slice(0, 2)) : pick(streets);
    const unit = narrow ? pick([null, '4']) : pick(units);
    const form = rand(4);
    let line1 = `${houseNumber} ${pick(street)}`;
    let line2 = null;
    if (unit && form === 0) line1 = `${line1} Apt ${unit}`;
    else if (unit && form === 1) line2 = `Unit ${unit}`;
    else if (unit && form === 2) line2 = `#${unit}`;
    else if (unit) line1 = `${line1} #${unit}`;
    return { customerId: `c${String(i).padStart(3, '0')}`, matchedVia: 'primary', address_line1: line1, address_line2: line2, city: pick(cities), zip: pick(zips) };
  }

  test('pairs equal brute force over 110 rows of varied spellings', () => {
    const rows = Array.from({ length: 110 }, (_, i) => randomRow(i));
    compare.sameStreetAddress.mockClear();
    const got = new Set(pairCustomersAtSameAddress(rows).map((p) => `${p.a}:${p.b}`));
    const { sameStreetAddress } = jest.requireActual('../services/estimator-engine/address-compare');
    const expected = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const x = rows[i];
        const y = rows[j];
        if (!_private.houseNumberOf(_private.candidateAddressString(x)) || !_private.houseNumberOf(_private.candidateAddressString(y))) continue;
        if (sameStreetAddress(_private.candidateAddressString(x), _private.candidateAddressString(y), { requireExactUnit: true })) {
          expected.add(`${x.customerId}:${y.customerId}`);
        }
      }
    }
    expect(expected.size).toBeGreaterThan(8);
    expect([...got].sort()).toEqual([...expected].sort());
  });

  test('every pair the comparator accepts shares a premise key, for any pair of spellings', () => {
    const { addressPremiseKey, sameStreetAddress } = jest.requireActual('../services/estimator-engine/address-compare');
    let accepted = 0;
    for (let n = 0; n < 1500; n += 1) {
      const x = randomRow(0, true);
      const y = randomRow(1, true);
      const tx = _private.candidateAddressString(x);
      const ty = _private.candidateAddressString(y);
      if (sameStreetAddress(tx, ty, { requireExactUnit: true })) {
        accepted += 1;
        expect(addressPremiseKey(tx)).toBe(addressPremiseKey(ty));
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});
