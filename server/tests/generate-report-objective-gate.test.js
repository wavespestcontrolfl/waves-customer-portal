const mockProfile = { serviceKey: 'termite_liquid', findingsType: 'termite_treatment' };
const mockProvider = jest.fn(async () => ({ ok: true, text: 'WHAT WE DID\n\nInspected the exterior wall.\n\nWHAT WE FOUND\n\nThe technician recorded mud tubes at the exterior wall.' }));
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
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: 'Termite Liquid Treatment', customer_id: 'customer-1' } : null;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;

beforeEach(() => mockProvider.mockClear());

test('a treatment target alone cannot open generation without recorded work or findings', async () => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: {
    scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Termite Liquid Treatment',
    structuredFindings: { type: 'termite_treatment', values: { target_termite: 'Subterranean' } },
  } }, res);
  expect(res.statusCode).toBe(400);
  expect(mockProvider).not.toHaveBeenCalled();
});

test('a treatment objective stays separate when actual work and observations permit generation', async () => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: {
    scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Termite Liquid Treatment',
    actionsCompleted: ['Inspected the exterior wall.'],
    observations: ['Mud tubes at the exterior wall.'],
    structuredFindings: { type: 'termite_treatment', values: { target_termite: 'Subterranean' } },
  } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain('Recorded treatment objectives (targets only');
  expect(text).toContain('Subterranean');
  expect(text).toContain('Inspected the exterior wall.');
  expect(text).not.toMatch(/Work recorded:\n|Findings observed:\n/);
});
