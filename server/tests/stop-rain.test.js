jest.mock('../services/scheduling/rain-fit', () => ({ boundedHourlyRain: jest.fn() }));
const { boundedHourlyRain } = require('../services/scheduling/rain-fit');
const { attachStopRain, zoneHourlyOutlooks, hourKey } = require('../services/scheduling/stop-rain');

const DATE = '2026-10-24';
const hours = [
  { startTime: '2026-10-24T08:00:00-04:00', rainChance: 10 },
  { startTime: '2026-10-24T09:00:00-04:00', rainChance: 55 },
  { startTime: '2026-10-24T13:00:00-04:00', rainChance: null },
];

describe('attachStopRain', () => {
  it('reads each stop its zone hourly chance at its window-start hour', () => {
    const services = [
      { id: 'a', zone: 'venice', status: 'confirmed', windowStart: '08:00' },
      { id: 'b', zone: 'venice', status: 'confirmed', windowStart: '09:30' },
      { id: 'c', zone: 'venice', status: 'confirmed', windowStart: '13:00' },
      { id: 'd', zone: 'venice', status: 'confirmed', windowStart: '16:00' },
      { id: 'e', zone: 'parrish', status: 'confirmed', windowStart: '08:00' },
      { id: 'f', zone: 'venice', status: 'cancelled', windowStart: '08:00' },
      { id: 'g', zone: 'venice', status: 'confirmed', windowStart: null },
    ];
    attachStopRain(services, DATE, { venice: hours, parrish: null });
    expect(services.map((s) => s.rainAtStop)).toEqual([10, 55, null, null, null, null, null]);
  });

  it('builds a null key for a malformed date or window', () => {
    expect(hourKey(DATE, '09:00')).toBe('2026-10-24T09');
    expect(hourKey('tomorrow', '09:00')).toBeNull();
    expect(hourKey(DATE, '')).toBeNull();
    expect(hourKey(DATE, '25:00')).toBeNull();
  });
});

describe('zoneHourlyOutlooks', () => {
  it('fetches each known zone once, bounded, and skips zones without coordinates', async () => {
    boundedHourlyRain.mockImplementation(async (lat) => (lat === 1 ? hours : null));
    const out = await zoneHourlyOutlooks(['venice', 'venice', 'nowhere', 'parrish'], { venice: { lat: 1, lng: 2 }, parrish: { lat: 3, lng: 4 } });
    expect(out).toEqual({ venice: hours, parrish: null });
    expect(boundedHourlyRain).toHaveBeenCalledTimes(2);
  });

  it('reads a rejected lookup as no outlook', async () => {
    boundedHourlyRain.mockRejectedValue(new Error('nws down'));
    await expect(zoneHourlyOutlooks(['venice'], { venice: { lat: 1, lng: 2 } })).resolves.toEqual({ venice: null });
  });
});
