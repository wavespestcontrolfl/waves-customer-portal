const mockProfile = { serviceKey: 'one_time_pest_control', findingsType: 'one_time_pest_treatment' };
const mockProvider = jest.fn(async () => ({ ok: true, text: 'WHAT WE DID\n\nRemoved webs from the recorded exterior areas.\n\nWHAT WE FOUND\n\nThe technician recorded web activity near the entry.' }));
jest.mock('../services/llm/call', () => ({ callOpenAI: (...args) => mockProvider(...args), callAnthropic: (...args) => mockProvider(...args) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));
jest.mock('../services/service-report/report-copy-context', () => ({ buildReportCopyContext: async () => ({ contextText: '', signals: {} }) }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const chain = {};
    for (const name of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) chain[name] = () => chain;
    chain.first = async () => table === 'scheduled_services'
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: 'General Pest Control', customer_id: 'customer-1' } : null;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;

test('a target-only typed form reaches generation as an objective without asserting work or observation', async () => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: {
    scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'General Pest Control',
    structuredFindings: { type: 'one_time_pest_treatment', values: { target_pest: 'Ants' } },
  } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain('Recorded treatment objectives (targets only');
  expect(text).toContain('Ants');
  expect(text).not.toMatch(/Work recorded:\n|Findings observed:\n/);
});
