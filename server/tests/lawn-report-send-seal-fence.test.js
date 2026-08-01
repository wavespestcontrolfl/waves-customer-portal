// Issue #3135 — the two send-seal interleavings that survived PR #3093, plus
// the two P1s codex raised on the first cut of the fix.
//
// 1) delivery-queue: the fence was gated on `awaiting_grounding`, so a
//    completion whose regeneration settled inside the hold window enqueued a
//    NORMAL job that dispatched with no version check and no send seal.
// 2) knowledge-bridge: only new-run REGISTRATION consulted the send seal, so a
//    run whose lease expired mid-flight could still overwrite the stored copy
//    while that exact copy was being mailed.
// r1) the fence target must be resolved by the SAME function the renderer uses,
//    or the worker can seal a different assessment than the one attached.
// r2) an assessment lookup ERROR must fail closed — never read as "not a lawn
//    record", which would dispatch unfenced.
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
jest.mock('../services/service-report/report-data', () => ({
  loadLinkedLawnAssessment: jest.fn(),
}));

const { processServiceReportDelivery } = require('../services/service-report/delivery-queue');
const { sendServiceReportV1Email } = require('../services/service-report/email-delivery');
const { loadLinkedLawnAssessment } = require('../services/service-report/report-data');
const KnowledgeBridge = require('../services/knowledge-bridge');

const SERVICE_ROW = { id: 'svc-1', customer_id: 'cust-1', scheduled_service_id: 'sched-1', service_id: null };

// The stored copy the fence captures a version of.
const ASSESSMENT_ROW = {
  recommendations: '{"summary":"x"}',
  ai_summary: 'x',
  updated_at: '2026-08-01T10:00:00Z',
};

// Chainable knex stub. service_records.first() yields the row the fence
// resolver is handed; lawn_assessments.first() yields the copy whose version
// the fence pins; everything else no-ops the way the queue writes expect.
function makeKnex({ serviceRow = SERVICE_ROW } = {}) {
  const knex = (table) => {
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      orderBy: () => chain,
      first: async () => {
        if (table === 'service_records') return serviceRow;
        if (table === 'lawn_assessments') return ASSESSMENT_ROW;
        return null;
      },
      update: async () => 1,
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

describe('#3135 — every lawn-report delivery is fenced, not just held ones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    KnowledgeBridge.sealRecommendationsForSend.mockResolvedValue(true);
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'assess-canonical' });
  });

  test('a NORMAL (never-held) lawn delivery still seals before dispatch', async () => {
    const knex = makeKnex();
    // No awaiting_grounding — the fast-settle path that previously dispatched
    // completely unfenced.
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(typeof opts.verifyBeforeSend).toBe('function');
    // Sanitize stays a HELD-path obligation — it must not leak onto the normal
    // path. (forceFreshPdf is now expected on any fenced delivery; see the r3
    // cached-object test.)
    expect(KnowledgeBridge.sanitizeStoredRecommendations).not.toHaveBeenCalled();

    await opts.verifyBeforeSend();
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-canonical', expect.any(String), expect.any(Function),
    );
    expect(KnowledgeBridge.releaseRecommendationSendSeal).toHaveBeenCalledWith('assess-canonical');
  });

  test('a held delivery keeps sanitize + forceFreshPdf AND fences', async () => {
    const knex = makeKnex();
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');
    expect(KnowledgeBridge.sanitizeStoredRecommendations).toHaveBeenCalledWith('assess-held');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(opts.forceFreshPdf).toBe(true);
    expect(typeof opts.verifyBeforeSend).toBe('function');
  });

  test('a record with no lawn assessment is unaffected — no fence, no seal', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(null);
    const knex = makeKnex();
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
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).not.toBe('sent');
  });
});

describe('#3135 r1/r2 — fence target resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    KnowledgeBridge.sealRecommendationsForSend.mockResolvedValue(true);
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'assess-canonical' });
  });

  test('r1: the fence seals the assessment the RENDERER resolves, via the shared resolver', async () => {
    const knex = makeKnex();
    // The held payload names a DIFFERENT row than canonical resolution picks —
    // a duplicated backlink query would have sealed the wrong one.
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');

    // Resolved through the renderer's own function, fail-closed, same knex.
    expect(loadLinkedLawnAssessment).toHaveBeenCalledWith(
      SERVICE_ROW, knex, { failClosed: true },
    );
    const opts = sendServiceReportV1Email.mock.calls[0][1];
    await opts.verifyBeforeSend();
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-canonical', expect.any(String), expect.any(Function),
    );
  });

  test('r1: a held delivery never loses its fence when canonical resolution finds nothing', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(null); // e.g. not yet confirmed
    const knex = makeKnex();
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);
    expect(out.status).toBe('sent');

    const opts = sendServiceReportV1Email.mock.calls[0][1];
    expect(typeof opts.verifyBeforeSend).toBe('function');
    await opts.verifyBeforeSend();
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-held', expect.any(String), expect.any(Function),
    );
  });

  // The Phase B seal-discard returns null, which the completion flow reads as
  // "generation failed" and answers by sanitizing. The sanitizer holds the same
  // advisory lock but a lock is not a seal check, so it now refuses while a
  // seal is live. From the queue's side that surfaces as an unverified
  // readiness error, and the delivery must defer rather than mail.
  test('a sanitize blocked by a live send seal defers the held delivery', async () => {
    KnowledgeBridge.sanitizeStoredRecommendations.mockResolvedValueOnce({
      changed: false,
      dropped: 0,
      error: 'send seal active — an attachment is being dispatched from the settled copy',
    });
    const knex = makeKnex();
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(out.error).toMatch(/send seal active/);
    expect(sendServiceReportV1Email).not.toHaveBeenCalled();
  });

  test('r3: the fence refuses when the RENDER used a different assessment', async () => {
    // The renderer resolves the assessment independently of the worker, and the
    // backlink is non-unique — a row confirmed in between becomes the render's
    // pick. Sealing the worker's older row would prove nothing about what was
    // attached, so the send defers.
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend({ renderedAssessmentId: 'assess-OTHER' });
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).not.toHaveBeenCalled();
  });

  test('r3: the fence proceeds when the render used the SAME assessment', async () => {
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend({ renderedAssessmentId: 'assess-canonical' });
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-canonical', expect.any(String), expect.any(Function),
    );
  });

  test('r3: a fenced delivery forces a fresh PDF so no cached object is attached', async () => {
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    await processServiceReportDelivery(delivery, knex);

    expect(sendServiceReportV1Email.mock.calls[0][1].forceFreshPdf).toBe(true);
  });

  // #3143 — the PDF's CONTENT provenance is unobtainable server-side: the
  // renderer points a headless browser at /report/:token and that page fetches
  // its own data, so nothing here can ask what the browser received. What IS
  // knowable is whether the ANSWER changed across the render window, which is
  // the actual race: the backlink is non-unique, so a newly confirmed or
  // relinked assessment can outrank the fenced one mid-render.
  test('#3143: a SELECTION change across the render defers the send', async () => {
    // Pre-render resolution picks the fenced row; the post-render re-check
    // sees a newly confirmed row outrank it.
    loadLinkedLawnAssessment
      .mockResolvedValueOnce({ id: 'assess-canonical' }) // pre-render
      .mockResolvedValueOnce({ id: 'assess-NEWLY-CONFIRMED' }); // post-render
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).not.toHaveBeenCalled();
  });

  test('#3143: an UNREADABLE post-render re-check fails closed', async () => {
    loadLinkedLawnAssessment
      .mockResolvedValueOnce({ id: 'assess-canonical' })
      .mockRejectedValueOnce(new Error('connection terminated'));
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).not.toHaveBeenCalled();
  });

  test('#3143: an unchanged selection proceeds to seal', async () => {
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'assess-canonical' });
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-canonical', expect.any(String), expect.any(Function),
    );
    // Resolved twice: once to pick the target, once to prove it didn't drift.
    expect(loadLinkedLawnAssessment).toHaveBeenCalledTimes(2);
  });

  test('#3143 r2: the held-payload fallback IS re-checked — null is a real answer', async () => {
    // Canonical resolution finds nothing pre-render (assessment not confirmed)
    // and still nothing after, so the answer is UNCHANGED and the send
    // proceeds on the held fallback id.
    loadLinkedLawnAssessment.mockResolvedValue(null);
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).toHaveBeenCalledWith(
      'assess-held', expect.any(String), expect.any(Function),
    );
    // Re-checked like any other fenced delivery: resolved before and after.
    expect(loadLinkedLawnAssessment).toHaveBeenCalledTimes(2);
  });

  test('#3143 r2: a held delivery DEFERS when a row becomes confirmed mid-render', async () => {
    // The hole in the previous cut: pre-render null exempted the fallback from
    // the re-check, so an assessment confirmed while the remote PDF rendered
    // could become the page's selection while the worker sealed only the held
    // row. null -> id is a change and must defer.
    loadLinkedLawnAssessment
      .mockResolvedValueOnce(null) // pre-render: nothing confirmed yet
      .mockResolvedValueOnce({ id: 'assess-NEWLY-CONFIRMED' }); // post-render
    sendServiceReportV1Email.mockImplementationOnce(async (_id, opts) => {
      const safe = await opts.verifyBeforeSend();
      return safe ? { ok: true, messageId: 'msg-1' } : { ok: false, error: 'deferring', retryable: true };
    });
    const knex = makeKnex();
    const delivery = {
      ...DELIVERY,
      payload: { awaiting_grounding: true, lawn_assessment_id: 'assess-held' },
    };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(KnowledgeBridge.sealRecommendationsForSend).not.toHaveBeenCalled();
  });

  test('r2: a lookup ERROR fails closed — deferred, never dispatched unfenced', async () => {
    loadLinkedLawnAssessment.mockRejectedValue(new Error('connection terminated'));
    const knex = makeKnex();
    const delivery = { ...DELIVERY, payload: { source: 'dispatch_complete' } };

    const out = await processServiceReportDelivery(delivery, knex);

    expect(out.status).not.toBe('sent');
    expect(out.error).toMatch(/connection terminated/);
    // The decisive assertion: nothing was mailed.
    expect(sendServiceReportV1Email).not.toHaveBeenCalled();
  });
});
