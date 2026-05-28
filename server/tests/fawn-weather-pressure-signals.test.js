const FawnWeather = require('../services/fawn-weather');

const typesFor = (month) => FawnWeather.getPressureSignals(month).map((s) => s.type);

describe('fawn-weather getPressureSignals', () => {
  // The Poa annua / pre-emergent window spans the turn of the year. The old
  // guard `m >= 10 && m <= 2` is impossible (no month is both), so the signal
  // never fired. It must fire Oct–Dec AND Jan–Feb.
  test('annual_bluegrass (Poa annua) fires across the winter window', () => {
    expect(typesFor(10)).toContain('annual_bluegrass'); // October
    expect(typesFor(11)).toContain('annual_bluegrass'); // November
    expect(typesFor(12)).toContain('annual_bluegrass'); // December
    expect(typesFor(1)).toContain('annual_bluegrass');  // January
    expect(typesFor(2)).toContain('annual_bluegrass');  // February
  });

  test('annual_bluegrass does NOT fire in the growing season', () => {
    expect(typesFor(6)).not.toContain('annual_bluegrass'); // June
    expect(typesFor(7)).not.toContain('annual_bluegrass'); // July
  });

  test('summer pest signals still fire (sanity)', () => {
    expect(typesFor(7)).toEqual(expect.arrayContaining(['chinch_bug', 'gray_leaf_spot']));
  });
});
