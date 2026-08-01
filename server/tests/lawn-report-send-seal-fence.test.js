// Issue #3135 — the two send-seal interleavings that survived PR #3093.
//
// 1) delivery-queue: the fence was gated on `awaiting_grounding`, so a
//    completion whose regeneration settled inside the hold window enqueued a
//    NORMAL job that dispatched with no version check and no send seal.
// 2) knowledge-bridge: only new-run REGISTRATION consulted the send seal, so a
//    run whose lease expired mid-flight could still overwrite the stored copy
//    while that exact copy was being mailed.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/service-report/email-delivery', () => ({
  sendServiceReportV1Email: jest.fn(async () => ({ ok: true, messageId: 'msg-1' })),
}));
jest.mock('../services/service-report/failure-alerts', () => ({
  alertServiceReportDeliveryFailed: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/knowledge-bridge', () => ({
  sanitizeStoredRecommendations: jest.fn(async () => ({ ok: true })),
  sealRecommendationsForSend: jest.fn(async () => true),
  renewRecommendationSendSeal: jest.fn(async () => true),
  releaseRecommendationSendSeal: jest.fn(async () => true),
}));

const { processServiceReportDelivery } = require('../services/service-report/delivery-queue');
const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');
const KnowledgeBridge = require('../services/knowledge-bridge');

// Chainable knex stub. `assessmentRow` is what a lawn_assessments lookup
// resolves to — null models a record with no lawn assessment at all.
function makeKnex({ assessmentRow }) {
  const knex = (table) => {
    const chain = {
      _table: table,
      where: () => chain,
      whereNull: () => chain,
      orderBy: () => chain,
      first: async () => (table === 'lawn_assessments' ? assessmentRow : null),
      update: async () => 1,
      then: undefined,
    };
    return chain;
  };
  knex.raw = jest.fn(() => 'RAW');
  return knex;
}

const DELIVERY = {
  id: 'del-1',
  channel: 'email',
  report_template_version: 'service_report_v1',
  service_record_id: 'svc-1',
  report_token: 'tok-1',
  report_url: 'https://portal.example/r/tok-1',
  pdf_url: null,
  attempts: 0,
};

const ASSESSMENT = {
  id: 'assess-1',
  recommendations: '{"summary":"x"}',
  ai_summary: 'x',
  updated_at: '2026-08-01T10:00:00Z',
};

describe('#3135 — every lawn-report delivery is fenced, not just held ones', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a NORMAL (never-held) lawn delivery still seals before dispatch', async () => {
    const knex = makeKnex({ assessmentRow: ASSESSMENT });
    // payload has NO awaiting_grounding — this is the fast-settle path that
    // previously dispatched completely unfenced.
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(typeof opts.verifyBeforeSend).toBe('function');
    // Held-path obligations must NOT leak onto the normal path.
    expect(opts.forceFreshPdf).toBe(false);
    expect(KnowledgeBridge.sanitizeStoredRecommendations).not.toHaveBeenCalled();

    // The fence actually seals the assessment it resolved.
    await opts.verifyBeforeSend();
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-1', expect.any(String), expect.any(Function),
    );
    // Seal is released once the delivery settles.
    expect(KnowledgeBridge.releaseRecommendationSendSeal).toHaveBeenCalledWith('assess-1');
  });

  test('a held delivery keeps sanitize + forceFreshPdf AND fences', async () => {
    const knex = makeKnex({ assessmentRow: ASSESSMENT });
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-1' },
    };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');
    expect(KnowledgeBridge.sanitizeStoredRecommendations).toHaveBeenCalledWith('assess-1');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(opts.forceFreshPdf).toBe(true);
    expect(typeof opts.verifyBeforeSend).toBe('function');
  });

  test('a record with no lawn assessment is unaffected — no fence, no seal', async () => {
    const knex = makeKnex({ assessmentRow: null });
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(opts.verifyBeforeSend).toBeNull();
    expect(KnowledgeBridge.sealRecommendationsForSend).not.toHaveBeenCalled();
    expect(KnowledgeBridge.releaseRecommendationSendSeal).not.toHaveBeenCalled();
  });

  test('an unsealable fence defers the send retryably instead of mailing', async () => {
    KnowledgeBridge.sealRecommendationsForSend.mockResolvedValueOnce(false);
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe
        ? { ok: true, messageId: 'msg-1' }
        : { ok: false, error: 'Report copy changed during render — deferring send', retryable: true };
    });
    const knex = makeKnex({ assessmentRow: ASSESSMENT });
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);
    // Deferred (requeued), never 'sent' — and never silently dropped.
    expect(out.status).not.toBe('sent');
  });
});
