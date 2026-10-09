// The Fast Complete sweep chip tapped off (owner 2026-10-08): the report
// writer is told the sweep was not done, over whatever the note says. Mirrors
// the handler-mocking pattern in generate-report-photo-content.test.js.
const mockProfile = { serviceKey: 'pest_general_quarterly', findingsType: null };
const mockProvider = jest.fn(async () => ({ ok: true, text: 'WHAT WE DID\n\nTreated the exterior perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }));
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
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: 'Quarterly Pest Control Service', customer_id: 'customer-1' } : null;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;
const db = require('../models/db');
// Captured once so per-test overrides (the assessment-validation tests
// below) can be reverted in beforeEach — no other test in this file relies
// on lawn_assessments resolving truthy, so leaking a custom impl forward
// would silently open the lawn-assessment-gate branch for unrelated tests.
const defaultDbImpl = db.getMockImplementation();

function mkReq(body) {
  return {
    techRole: 'admin',
    body: {
      scheduledServiceId: '11111111-1111-4111-8111-111111111111',
      serviceType: 'Quarterly Pest Control Service',
      ...body,
    },
  };
}
function mkRes() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
}

beforeEach(() => { mockProvider.mockClear(); db.mockImplementation(defaultDbImpl); });

const NOTE = 'Sprayed the perimeter and swept the eaves.';
const LINE = 'Technician correction: the eaves and webs were NOT swept on this visit.';

test('the chip tapped off: the prompt carries the correction right under the completed actions', async () => {
  const res = mkRes();
  await handler(mkReq({ serviceNotes: NOTE, actionsCompleted: [], sweepNotDone: true }), res);
  expect(res.statusCode).toBe(200);
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain(`Actions completed: Not specified\n${LINE}`);
  expect(text).toContain('whatever the note says');
});

test('no correction unless the sheet sends an exact true', async () => {
  for (const body of [{}, { sweepNotDone: false }, { sweepNotDone: 'true' }, { sweepNotDone: 1 }]) {
    mockProvider.mockClear();
    const res = mkRes();
    await handler(mkReq({ serviceNotes: NOTE, actionsCompleted: ['Swept eaves, window frames, door frames, and lanai'], fresh: true, ...body }), res);
    expect(res.statusCode).toBe(200);
    const text = mockProvider.mock.calls[0][0].text;
    expect(text).not.toContain('Technician correction');
    expect(text).toContain('Actions completed: Swept eaves, window frames, door frames, and lanai\nAreas serviced:');
  }
});
