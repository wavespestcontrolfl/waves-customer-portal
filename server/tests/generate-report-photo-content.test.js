// GATE_REPORT_PHOTO_CONTENT (owner spec 2026-09-27): tech-reviewed photo
// captions/summary ground the AI report writer's prompt as a clearly
// labeled TECHNICIAN PHOTO OBSERVATIONS block. Mirrors the handler-mocking
// pattern in generate-report-objective-gate.test.js.
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

beforeEach(() => {
  mockProvider.mockClear();
  delete process.env.GATE_REPORT_PHOTO_CONTENT;
});
afterEach(() => { delete process.env.GATE_REPORT_PHOTO_CONTENT; });

test('gate off: reviewed captions alone cannot open generation', async () => {
  const res = mkRes();
  await handler(mkReq({ photoCaptions: ['Ants at the kitchen baseboard.'] }), res);
  expect(res.statusCode).toBe(400);
  expect(mockProvider).not.toHaveBeenCalled();
});

test('gate on: reviewed captions alone open generation and ground a labeled, observation-only block', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({
    photoCaptions: ['Ants at the kitchen baseboard.', 'Droppings under the sink.'],
    photoSummary: 'Photos document ant activity and rodent signs.',
  }), res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain('TECHNICIAN PHOTO OBSERVATIONS');
  expect(text).toContain('Ants at the kitchen baseboard.');
  expect(text).toContain('Droppings under the sink.');
  expect(text).toContain('Photos document ant activity and rodent signs.');
});

test('gate on: a photo summary with no captions never opens generation and never renders the block', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({ photoSummary: 'General service photos from today.' }), res);
  expect(res.statusCode).toBe(400);
  expect(mockProvider).not.toHaveBeenCalled();
});

test('gate on: a bare photo count still cannot open generation (unchanged behavior)', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({ photoCount: 4 }), res);
  expect(res.statusCode).toBe(400);
  expect(mockProvider).not.toHaveBeenCalled();
});

test('gate on: captions and summary are capped server-side regardless of what the client sent', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  const longCaption = 'x'.repeat(250);
  const captions = Array.from({ length: 8 }, () => longCaption);
  await handler(mkReq({ photoCaptions: captions, photoSummary: 'y'.repeat(900) }), res);
  expect(res.statusCode).toBe(200);
  const text = mockProvider.mock.calls[0][0].text;
  // Only the first 5 captions render, each capped at 200 chars.
  expect(text).toContain('Photo 5:');
  expect(text).not.toContain('Photo 6:');
  expect(text).toContain(longCaption.slice(0, 200));
  expect(text).not.toContain(longCaption);
  expect(text).toContain('y'.repeat(600));
  expect(text).not.toContain('y'.repeat(601));
});

test('gate on: non-string caption entries are dropped rather than crashing the route', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({ photoCaptions: ['Ants at the baseboard.', null, 42, { caption: 'nope' }, '   '] }), res);
  expect(res.statusCode).toBe(200);
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain('Photo 1: Ants at the baseboard.');
  expect(text).not.toContain('Photo 2:');
});

test('gate on: an access code in a caption or the summary is redacted before it reaches the prompt (pre-push P1)', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({
    photoCaptions: [
      'The photo under the sink shows the gate code 4821 written on the wall.',
      'Lockbox 1234 is by the front door.',
    ],
    photoSummary: 'Notes mention the gate code 4821 and lockbox 1234 for access.',
  }), res);
  expect(res.statusCode).toBe(200);
  const text = mockProvider.mock.calls[0][0].text;
  expect(text).toContain('gate code [redacted]');
  expect(text).toContain('Lockbox [redacted]');
  expect(text).toContain('Summary: Notes mention the gate code [redacted] and lockbox [redacted] for access.');
  expect(text).not.toContain('4821');
  expect(text).not.toContain('1234');
});
