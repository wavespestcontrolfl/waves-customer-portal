const { scorePests, levelFor, trendFor } = require('../services/pest-forecast/pests');
const { resolveLocation, listLocations, BY_SLUG } = require('../services/pest-forecast/locations');
const { flags } = require('../services/pest-forecast/weather');
const { computeForecast } = require('../services/pest-forecast/forecast');

// Deterministic signal builder — same shape weather.flags() produces.
const sig = (overrides = {}) => flags({ hasWeather: true, source: 'nws', ...overrides });
const noWeather = () => flags({ hasWeather: false });

describe('pest seasonality model', () => {
  test('every pest scores within 0–10 for every month', () => {
    for (let m = 1; m <= 12; m += 1) {
      const rows = scorePests(m, noWeather());
      for (const r of rows) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(10);
        expect(r.score10).toBeGreaterThanOrEqual(0);
        expect(r.score10).toBeLessThanOrEqual(10);
      }
    }
  });

  test('the level word always agrees with the displayed /10 number', () => {
    const cases = [sig({ tempHighF: 91, precipChance: 70 }), sig({ tempHighF: 60, precipChance: 5 }), noWeather()];
    for (const s of cases) {
      for (let m = 1; m <= 12; m += 1) {
        for (const r of scorePests(m, s)) {
          expect(r.level).toBe(levelFor(r.score10));
        }
      }
    }
  });

  test('results are ranked by score descending', () => {
    const rows = scorePests(8, sig({ tempHighF: 91, precipChance: 70, recentRainIn: 1.0 }));
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
    }
  });

  test('a warm, wet August spikes mosquitoes to high', () => {
    const rows = scorePests(8, sig({ tempHighF: 91, precipChance: 70 }));
    const mosq = rows.find((r) => r.key === 'mosquitoes');
    expect(mosq.level).toBe('high');
    expect(mosq.trend).toBe('up');
  });

  test('a dry winter keeps mosquitoes low', () => {
    const rows = scorePests(1, sig({ tempHighF: 70, precipChance: 5 }));
    const mosq = rows.find((r) => r.key === 'mosquitoes');
    expect(['low', 'minimal']).toContain(mosq.level);
  });

  test('termite swarm pressure scales with season — high in spring, muted off-season', () => {
    const spring = scorePests(3, sig({ tempHighF: 86, precipChance: 60 }))
      .find((r) => r.key === 'subterranean_termites');
    const fall = scorePests(10, sig({ tempHighF: 86, precipChance: 60 }))
      .find((r) => r.key === 'subterranean_termites');
    expect(spring.score).toBeGreaterThan(fall.score + 3);
    expect(['elevated', 'high']).toContain(spring.level);
  });

  test('a cool snap drives rodent pressure up', () => {
    const warm = scorePests(12, sig({ tempHighF: 80 })).find((r) => r.key === 'rodents');
    const cold = scorePests(12, sig({ tempHighF: 58 })).find((r) => r.key === 'rodents');
    expect(cold.score).toBeGreaterThan(warm.score);
    expect(cold.trend).toBe('up');
  });

  test('levelFor and trendFor map as specified', () => {
    expect(levelFor(9)).toBe('high');
    expect(levelFor(6.5)).toBe('elevated');
    expect(levelFor(4)).toBe('moderate');
    expect(levelFor(2)).toBe('low');
    expect(levelFor(1)).toBe('minimal');
    expect(trendFor(8, 6)).toBe('up');
    expect(trendFor(4, 6)).toBe('down');
    expect(trendFor(6.2, 6)).toBe('flat');
  });
});

describe('weather flag thresholds', () => {
  test('warm/hot/coolSnap temperature boundaries', () => {
    expect(flags({ hasWeather: true, tempHighF: 85 }).warm).toBe(true);
    expect(flags({ hasWeather: true, tempHighF: 84 }).warm).toBe(false);
    expect(flags({ hasWeather: true, tempHighF: 92 }).hot).toBe(true);
    expect(flags({ hasWeather: true, tempHighF: 66 }).coolSnap).toBe(true);
    expect(flags({ hasWeather: true, tempHighF: 67 }).coolSnap).toBe(false);
  });

  test('wet from precip chance OR recent rainfall; dry needs low both', () => {
    expect(flags({ hasWeather: true, precipChance: 50 }).wet).toBe(true);
    expect(flags({ hasWeather: true, precipChance: 10, recentRainIn: 0.8 }).wet).toBe(true);
    expect(flags({ hasWeather: true, precipChance: 20 }).dry).toBe(true);
    expect(flags({ hasWeather: true, precipChance: 20, recentRainIn: 0.5 }).dry).toBe(false);
  });

  test('missing readings produce no false flags', () => {
    const f = noWeather();
    expect(f.warm || f.hot || f.wet || f.dry || f.coolSnap).toBe(false);
    expect(f.hasWeather).toBe(false);
  });
});

describe('location resolution', () => {
  test('resolves a known slug', () => {
    expect(resolveLocation({ location: 'bradenton-fl' }).label).toBe('Bradenton, FL');
  });

  test('resolves a FL zip by prefix to the nearest tracked city', () => {
    expect(resolveLocation({ zip: '34205' }).slug).toBe('bradenton-fl');
    expect(resolveLocation({ zip: '33101' }).slug).toBe('miami-fl');
  });

  test('falls back to Southwest Florida for unknown/out-of-state input', () => {
    expect(resolveLocation({ zip: '90210' }).slug).toBe('southwest-florida');
    expect(resolveLocation({}).slug).toBe('southwest-florida');
    expect(resolveLocation({ location: 'not-a-place' }).slug).toBe('southwest-florida');
  });

  test('every listed location resolves and carries coordinates', () => {
    for (const l of listLocations()) {
      const full = BY_SLUG.get(l.slug);
      expect(Number.isFinite(full.lat)).toBe(true);
      expect(Number.isFinite(full.lng)).toBe(true);
    }
  });
});

describe('computeForecast payload', () => {
  const bradenton = BY_SLUG.get('bradenton-fl');
  const augDate = new Date('2026-08-15T16:00:00Z'); // ET = August

  test('assembles a complete, ranked payload', () => {
    const out = computeForecast(bradenton, sig({ tempHighF: 91, precipChance: 70, recentRainIn: 1.0 }), augDate);
    expect(out.location.slug).toBe('bradenton-fl');
    expect(out.month).toBe(8);
    expect(out.month_name).toBe('August');
    expect(out.as_of_date).toBe('2026-08-15');
    expect(out.pests.length).toBeGreaterThanOrEqual(8);
    expect(out.weather.available).toBe(true);
    expect(out.weather.temp_high_f).toBe(91);
    expect(out.attribution.url).toContain('utm_source=embed');
    expect(out.attribution.url).toContain('bradenton-fl');
    expect(typeof out.summary).toBe('string');
    expect(out.disclaimer).toMatch(/not a guarantee/i);
  });

  test('summary names a rising pest on a warm wet week', () => {
    const out = computeForecast(bradenton, sig({ tempHighF: 91, precipChance: 70 }), augDate);
    expect(out.summary.toLowerCase()).toContain('climbing');
  });

  test('degrades to seasonal outlook when live weather is unavailable', () => {
    const out = computeForecast(bradenton, noWeather(), augDate);
    expect(out.weather.available).toBe(false);
    expect(out.weather.summary).toMatch(/seasonal/i);
    expect(out.pests.length).toBeGreaterThanOrEqual(8);
  });
});
