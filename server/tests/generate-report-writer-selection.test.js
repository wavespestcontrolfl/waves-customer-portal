const mockProfile = { serviceKey: null, findingsType: null };
let mockProfileError = null;
let mockScheduledServiceError = null;
let mockScheduledServiceType = 'General Pest Control';
let mockProviderResult = { ok: true, text: 'WHAT WE DID\n\nRemoved webs from the recorded exterior areas.\n\nWHAT WE FOUND\n\nThe technician recorded web activity near the entry.' };
const mockProvider = jest.fn(async () => mockProviderResult);
jest.mock('../services/llm/call', () => ({ callOpenAI: (...args) => mockProvider(...args), callAnthropic: (...args) => mockProvider(...args) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => {
    if (mockProfileError) throw mockProfileError;
    return mockProfile;
  },
}));
jest.mock('../services/service-report/report-copy-context', () => ({ buildReportCopyContext: async () => ({ contextText: '', signals: {} }) }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const chain = {};
    for (const name of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) chain[name] = () => chain;
    chain.first = async () => {
      if (table === 'scheduled_services' && mockScheduledServiceError) throw mockScheduledServiceError;
      return table === 'scheduled_services'
        ? { id: '11111111-1111-4111-8111-111111111111', service_type: mockScheduledServiceType, customer_id: 'customer-1' } : null;
    };
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;

beforeEach(() => {
  mockProvider.mockClear();
  mockProviderResult = { ok: true, text: 'WHAT WE DID\n\nRemoved webs from the recorded exterior areas.\n\nWHAT WE FOUND\n\nThe technician recorded web activity near the entry.' };
  mockProfileError = null;
  mockScheduledServiceError = null;
  mockScheduledServiceType = 'General Pest Control';
  Object.assign(mockProfile, { serviceKey: null, serviceName: null, findingsType: null, synthesized: false });
});
test.each(['wdo_inspection', 'termite_slab_pretreat', 'unknown_service'])(
  '%s never reaches the provider through a generic display label', async (serviceKey) => {
    mockProfile.serviceKey = serviceKey;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'General Pest Control', actionsCompleted: ['Removed exterior webs'] } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'report_writer_unavailable' }));
    expect(mockProvider).not.toHaveBeenCalled();
  },
);
test('the canonical initial-cleanout service reaches the existing provider with the pest contract', async () => {
  mockProfile.serviceKey = 'pest_initial_cleanout';
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Old label', actionsCompleted: ['Removed exterior webs'] } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  expect(mockProvider.mock.calls[0][0].system).toContain('RECURRING PEST CONTROL SERVICE MODULE');
});
test('a synthesized generic profile retains the legacy label-based writer', async () => {
  Object.assign(mockProfile, { serviceKey: null, serviceName: 'Lawn Care', synthesized: true });
  mockScheduledServiceType = 'Lawn Care';
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Lawn Care', actionsCompleted: ['Applied recorded lawn treatment'] } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  expect(mockProvider.mock.calls[0][0].system).toContain('SERVICE REPORT COPY — LAWN');
});
test('the deterministic fallback names the canonical service instead of a stale request label', async () => {
  Object.assign(mockProfile, { serviceKey: 'pest_initial_cleanout', serviceName: 'Initial Pest Cleanout' });
  mockScheduledServiceType = 'Stale Lawn Label';
  mockProviderResult = { ok: false, reason: 'provider_unavailable' };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Stale Lawn Label', actionsCompleted: ['Removed exterior webs'] } }, res);
  expect(res.statusCode).toBe(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    fallback: true,
    report: expect.stringContaining('Initial Pest Cleanout'),
  }));
  expect(res.json.mock.calls[0][0].report).not.toContain('Stale Lawn Label');
});
test('a profile outage preserves the existing notes-only label fallback', async () => {
  mockProfileError = new Error('profile read unavailable');
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'Stale request label', actionsCompleted: ['Removed exterior webs'] } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  expect(mockProvider.mock.calls[0][0].system).toContain('RECURRING PEST CONTROL SERVICE MODULE');
});
test('a scheduled-service lookup outage preserves the existing notes-only label fallback', async () => {
  mockScheduledServiceError = new Error('scheduled service read unavailable');
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: '11111111-1111-4111-8111-111111111111', serviceType: 'General Pest Control', actionsCompleted: ['Removed exterior webs'] } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  expect(mockProvider.mock.calls[0][0].system).toContain('RECURRING PEST CONTROL SERVICE MODULE');
});
