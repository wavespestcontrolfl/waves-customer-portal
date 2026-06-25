const {
  DEFAULT_CALL_ROUTING_CONFIG,
  mergeCallRoutingConfig,
  getCallRoutingConfig,
} = require('../services/call-routing-config');

describe('mergeCallRoutingConfig', () => {
  test('defaults are inert (empty agentEndpoint, backstop on)', () => {
    const c = mergeCallRoutingConfig(null);
    expect(c.agentEndpoint).toBe('');
    expect(c.noAnswerBackstopEnabled).toBe(true);
    expect(c.aiAnswersFirst).toBe(false);
    expect(c.ringTimeoutSec).toBe(30);
    expect(c.answerFirstSchedule.enabled).toBe(false);
  });

  test('clamps ringTimeoutSec to [5,120] and agentTimeoutSec to [5,30]', () => {
    expect(mergeCallRoutingConfig({ ringTimeoutSec: 2 }).ringTimeoutSec).toBe(5);
    expect(mergeCallRoutingConfig({ ringTimeoutSec: 999 }).ringTimeoutSec).toBe(120);
    expect(mergeCallRoutingConfig({ agentTimeoutSec: 1 }).agentTimeoutSec).toBe(5);
    expect(mergeCallRoutingConfig({ agentTimeoutSec: 99 }).agentTimeoutSec).toBe(30);
  });

  test('coerces booleans strictly', () => {
    expect(mergeCallRoutingConfig({ aiAnswersFirst: 'yes' }).aiAnswersFirst).toBe(false);
    expect(mergeCallRoutingConfig({ aiAnswersFirst: true }).aiAnswersFirst).toBe(true);
    // backstop defaults true when undefined; only explicit false disables
    expect(mergeCallRoutingConfig({}).noAnswerBackstopEnabled).toBe(true);
    expect(mergeCallRoutingConfig({ noAnswerBackstopEnabled: false }).noAnswerBackstopEnabled).toBe(false);
  });

  test('rejects non-string agentEndpoint, trims valid', () => {
    expect(mergeCallRoutingConfig({ agentEndpoint: 123 }).agentEndpoint).toBe('');
    expect(mergeCallRoutingConfig({ agentEndpoint: '  +19415551234 ' }).agentEndpoint).toBe('+19415551234');
  });

  test('sanitizes schedule: coerces hours, dedupes/validates openDays', () => {
    const s = mergeCallRoutingConfig({
      answerFirstSchedule: { enabled: 'x', startHourET: '18', endHourET: 8, openDays: [1, 1, 2, 9, 'x', 5, -1] },
    }).answerFirstSchedule;
    expect(s.enabled).toBe(false);       // strict boolean
    expect(s.startHourET).toBe(18);
    expect(s.endHourET).toBe(8);
    expect(s.openDays).toEqual([1, 2, 5]); // 9, 'x', -1 dropped; deduped
  });

  test('accepts a JSON string value (as stored in system_settings)', () => {
    const c = mergeCallRoutingConfig(JSON.stringify({ ringTimeoutSec: 45, agentEndpoint: '+1999' }));
    expect(c.ringTimeoutSec).toBe(45);
    expect(c.agentEndpoint).toBe('+1999');
  });
});

describe('getCallRoutingConfig — fail-safe runtime read', () => {
  test('reads + merges a stored row', async () => {
    const mockDb = () => ({ where: () => ({ first: async () => ({ value: JSON.stringify({ ringTimeoutSec: 20, agentEndpoint: '+1888' }) }) }) });
    const c = await getCallRoutingConfig(mockDb);
    expect(c.ringTimeoutSec).toBe(20);
    expect(c.agentEndpoint).toBe('+1888');
  });

  test('DB error → inert defaults (so a read failure can never misroute a call)', async () => {
    const throwingDb = () => ({ where: () => ({ first: async () => { throw new Error('db down'); } }) });
    const c = await getCallRoutingConfig(throwingDb);
    expect(c).toEqual(mergeCallRoutingConfig(null));
    expect(c.agentEndpoint).toBe(''); // ⇒ decideVoiceRoute returns 'normal'
  });
});
