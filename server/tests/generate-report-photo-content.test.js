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

beforeEach(() => {
  mockProvider.mockClear();
  db.mockImplementation(defaultDbImpl);
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

// Pre-push P1 (Codex #5145 r1): the gate must be a kill switch for the
// PROMPT TEXT ITSELF, not just for whether the caption block is appended —
// a generation with the gate off must send the byte-identical pre-branch
// system prompt and photo-count note on EVERY request, never the rewritten
// provenance wording, even though no caption ever reaches it either way.
// Original (pre-branch) wording, reproduced verbatim from the diff this P1
// closed — this is what a gate-off request must still send.
const PRE_BRANCH_INVALID_OBSERVATIONS_CLAUSE = 'Two narrowly scoped sources may also be used from GROUNDING CONTEXT: tech-confirmed LAWN ASSESSMENT scores are verified findings for this visit and may support their supplied deltas; TREE & SHRUB REVIEWED PHOTO SIGNALS may describe reviewed visual appearances only, with their photo-signal provenance. Tree photo signals never establish a diagnosis, confirmed cause, observed pest species, or completed work.';
const PRE_BRANCH_PHOTO_COUNT_NOTE = 'use only separately supplied TREE & SHRUB REVIEWED PHOTO SIGNALS with their limited provenance, never infer unseen photo contents';
// Gate-ON wording (this branch's own additions) — used only to normalize
// both sides to the SAME placeholder below, proving the rest of the prompt
// is untouched by the gate.
const GATE_ON_INVALID_OBSERVATIONS_CLAUSE = 'Three narrowly scoped sources may also be used, each with its own limited provenance: tech-confirmed LAWN ASSESSMENT scores (from GROUNDING CONTEXT) are verified findings for this visit and may support their supplied deltas; TREE & SHRUB REVIEWED PHOTO SIGNALS (from GROUNDING CONTEXT) may describe reviewed visual appearances only; TECHNICIAN PHOTO OBSERVATIONS below may reference what a specific photo shows ("the photo under the kitchen sink shows droppings") but never upgrades that observation into a confirmed finding, diagnosis, or completed work beyond what the photo visibly shows. None of these three establish a diagnosis, confirmed cause, observed pest species, or completed work.';
const GATE_ON_PHOTO_COUNT_NOTE = 'use only separately supplied TREE & SHRUB REVIEWED PHOTO SIGNALS or a TECHNICIAN PHOTO OBSERVATIONS block below, each with its own limited provenance — never infer unseen photo contents';

test('gate off: the system prompt and photo-count note are byte-identical to the pre-branch wording, even with substantive non-photo input', async () => {
  const res = mkRes();
  await handler(mkReq({ observations: ['Ants along the exterior baseboard.'] }), res);
  expect(res.statusCode).toBe(200);
  const { system, text } = mockProvider.mock.calls[0][0];
  expect(system).toContain(PRE_BRANCH_INVALID_OBSERVATIONS_CLAUSE);
  expect(system).not.toContain('Three narrowly scoped sources');
  expect(system).not.toContain('TECHNICIAN PHOTO OBSERVATIONS');
  expect(text).toContain(`(a count alone supplies no visual facts; ${PRE_BRANCH_PHOTO_COUNT_NOTE})`);
  expect(text).not.toContain('TECHNICIAN PHOTO OBSERVATIONS');
  // No whole-prompt hash pin here on purpose: the rest of the system prompt
  // belongs to main and changes with unrelated work (a pinned hash broke on
  // the first merge of main, 2026-09-28). The kill switch is proven by the
  // verbatim legacy clause above plus the differential test below, which
  // shows gate-on differs from gate-off ONLY by the gated clause.
});

test('gate on: the same request differs from the gate-off prompt ONLY by the gated additions', async () => {
  const offRes = mkRes();
  await handler(mkReq({ observations: ['Ants along the exterior baseboard, second visit.'] }), offRes);
  const offSystem = mockProvider.mock.calls[0][0].system;
  const offText = mockProvider.mock.calls[0][0].text;
  mockProvider.mockClear();

  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const onRes = mkRes();
  await handler(mkReq({ observations: ['Ants along the exterior baseboard, second visit.'] }), onRes);
  const onSystem = mockProvider.mock.calls[0][0].system;
  const onText = mockProvider.mock.calls[0][0].text;

  expect(onRes.statusCode).toBe(200);
  expect(offRes.statusCode).toBe(200);
  expect(onSystem).not.toBe(offSystem);
  // The ONLY difference in the system prompt is the provenance clause
  // swapping from the "Two"/old wording to the "Three"/new wording — every
  // other character is identical.
  expect(onSystem.replace(GATE_ON_INVALID_OBSERVATIONS_CLAUSE, 'X')).toBe(
    offSystem.replace(PRE_BRANCH_INVALID_OBSERVATIONS_CLAUSE, 'X'),
  );
  expect(onSystem).toContain('Three narrowly scoped sources');
  expect(onSystem).toContain('TECHNICIAN PHOTO OBSERVATIONS below may reference');
  // The user-message photo-count note is the only other gated difference —
  // no photoObservationsBlock is appended either way since no captions were
  // sent, so `text` differs ONLY by that one parenthetical note.
  expect(onText).not.toBe(offText);
  expect(onText.replace(GATE_ON_PHOTO_COUNT_NOTE, 'X')).toBe(offText.replace(PRE_BRANCH_PHOTO_COUNT_NOTE, 'X'));
});

// Pre-push P2 (Codex #5145 r2): a valid lawn assessment + reviewed captions
// pass the INPUT gate (hasReportInput), but assessmentWasOnlyInput ignored
// captions entirely — so when the assessment grounding load then failed,
// the route 503'd `lawn_assessment_grounding_unavailable` even though the
// captions are substantive on their own and generation could proceed from
// them. `db` here validates the lawn assessment truthy
// (hasValidLawnAssessment); buildReportCopyContext is already mocked to
// return `signals: {}` (no hasCurrentLawnAssessment) — i.e. the grounding
// load "failed" for every test in this file, which is exactly the scenario
// these two tests are about.
function withValidLawnAssessment() {
  db.mockImplementation((table) => {
    if (table === 'lawn_assessments') {
      return {
        where: function where() { return this; },
        first: async () => ({ id: 'assessment-1' }),
      };
    }
    return defaultDbImpl(table);
  });
}

test('gate on: a valid assessment + reviewed captions, assessment grounding fails → generation still proceeds on the photo block', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  withValidLawnAssessment();
  const res = mkRes();
  await handler(mkReq({
    lawnAssessmentId: 'assessment-1',
    photoCaptions: ['Thin turf along the south fence line.'],
  }), res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
});

test('gate off: the same assessment-only-plus-captions request still 503s lawn_assessment_grounding_unavailable', async () => {
  withValidLawnAssessment();
  const res = mkRes();
  await handler(mkReq({
    lawnAssessmentId: 'assessment-1',
    photoCaptions: ['Thin turf along the south fence line.'],
  }), res);
  expect(res.statusCode).toBe(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'lawn_assessment_grounding_unavailable' }));
  expect(mockProvider).not.toHaveBeenCalled();
});

// Pre-push P2 (Codex #5145 r3): the client's generation-invalidation
// watcher needs the server's own verdict on whether THIS generation
// actually included photo grounding — with the gate off (the default) the
// key must be OMITTED entirely (not `photoGroundingUsed: false`) so the
// gate-off response stays byte-identical to before this fix.
test('gate off: the response omits photoGroundingUsed entirely', async () => {
  const res = mkRes();
  await handler(mkReq({ observations: ['Ants along the exterior baseboard.'] }), res);
  expect(res.statusCode).toBe(200);
  const body = res.json.mock.calls[0][0];
  expect(body).not.toHaveProperty('photoGroundingUsed');
});

test('gate on, no captions (summary-only, cannot open generation on its own): irrelevant here, but a caption-free gate-on generation still omits the flag', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({ observations: ['Ants along the exterior baseboard.'] }), res);
  expect(res.statusCode).toBe(200);
  const body = res.json.mock.calls[0][0];
  expect(body).not.toHaveProperty('photoGroundingUsed');
});

test('gate on + at least one caption: the response carries photoGroundingUsed: true', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  const res = mkRes();
  await handler(mkReq({ photoCaptions: ['Ants at the kitchen baseboard.'] }), res);
  expect(res.statusCode).toBe(200);
  const body = res.json.mock.calls[0][0];
  expect(body.photoGroundingUsed).toBe(true);
});

// Codex #5145 r5: the deterministic fallback is composed from structured
// actions only and never reads the captions, so its response must not tell
// the client that photo content grounded the installed copy.
test('gate on + captions, both providers fail → the deterministic fallback omits photoGroundingUsed', async () => {
  process.env.GATE_REPORT_PHOTO_CONTENT = 'true';
  mockProvider.mockImplementation(async () => ({ ok: false, reason: 'provider_unavailable' }));
  try {
    const res = mkRes();
    await handler(mkReq({
      actionsCompleted: ['Removed exterior webs'],
      photoCaptions: ['Webbing under the front eave.'],
    }), res);
    expect(res.statusCode).toBe(200);
    const body = res.json.mock.calls[0][0];
    expect(body.fallback).toBe(true);
    expect(body.deterministic).toBe(true);
    expect(body).not.toHaveProperty('photoGroundingUsed');
    expect(body.report).not.toContain('Webbing under the front eave');
  } finally {
    mockProvider.mockImplementation(async () => ({ ok: true, text: 'WHAT WE DID\n\nTreated the exterior perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }));
  }
});
