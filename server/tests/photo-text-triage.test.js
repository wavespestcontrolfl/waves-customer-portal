// Photo-text auto-triage: guards, draft copy, and the inbound hook end to
// end through the REAL assessment create path (services/photo-assessment-
// create.js) with S3, sharp, and both vision ladders mocked. Real SQL for
// the claim / pending-draft / suppression reads lives in
// photo-text-triage-postgres.test.js.

const mockState = {};
function resetState() {
  Object.assign(mockState, {
    tech: null,
    prefs: null,
    pendingDraft: [], // successive md.first() results (pre-claim check, pre-insert recheck)
    counts: { photo_triage_at: 0, photo_triage_classified_at: 0 },
    alreadyTriaged: false,
    message: null,
    conversationCustomerId: null,
    customerRow: null,
    inserts: {},
    updates: [],
    pendingWhere: [],
    raws: [],
    draftInsertFails: false,
    messageLookupFails: false,
  });
}
resetState();

function mockQuery(table) {
  const q = {};
  for (const method of ['leftJoin', 'orderBy', 'limit', 'select', 'whereRaw', 'orWhereRaw', 'orWhere', 'whereNull', 'whereIn']) {
    q[method] = () => q;
  }
  q.where = (arg, ...rest) => {
    if (typeof arg === 'function') {
      const sub = {};
      for (const m of ['whereRaw', 'orWhereRaw', 'orWhere', 'where']) {
        sub[m] = (...args) => { mockState.pendingWhere.push([m, ...args]); return sub; };
      }
      arg.call(sub);
    } else if (arg && typeof arg === 'object') {
      q.whereObj = arg;
    } else {
      q.lastWhere = [arg, ...rest];
    }
    return q;
  };
  q.first = async () => {
    if (table === 'technicians') return mockState.tech;
    if (table === 'notification_prefs') return mockState.prefs;
    if (table === 'message_drafts as md') return mockState.pendingDraft.shift() || null;
    if (table === 'messages') {
      if (mockState.messageLookupFails) throw new Error('messages lookup timeout');
      return mockState.message;
    }
    if (table === 'conversations') return mockState.conversationCustomerId ? { customer_id: mockState.conversationCustomerId } : null;
    if (table === 'customers') return mockState.customerRow;
    return null;
  };
  q.count = async () => [{ n: mockState.counts[q.lastWhere?.[0]] ?? 0 }];
  q.update = async (patch) => {
    mockState.updates.push({ table, patch });
    return mockState.alreadyTriaged ? [] : [{ id: 'msg-1' }];
  };
  q.insert = (row) => {
    if (table === 'message_drafts' && mockState.draftInsertFails) throw new Error('drafts table unavailable');
    (mockState.inserts[table] = mockState.inserts[table] || []).push(row);
    const id = table === 'message_drafts' ? 'draft-1' : 'assess-1';
    return { returning: async () => [{ id, created_at: new Date('2026-09-24T14:00:00Z') }] };
  };
  return q;
}
const mockDb = jest.fn((table) => mockQuery(table));
mockDb.fn = { now: () => 'NOW' };
mockDb.raw = jest.fn(async () => ({}));
mockDb.transaction = jest.fn(async (fn) => {
  const trx = (table) => mockQuery(table);
  trx.raw = jest.fn(async (sql, bindings) => { mockState.raws.push([sql, bindings]); return {}; });
  return fn(trx);
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSuppression = { state: { suppressionLoaded: true } };
jest.mock('../services/messaging/validators/suppression', () => {
  const actual = jest.requireActual('../services/messaging/validators/suppression');
  return {
    ...actual,
    loadSuppressionState: jest.fn(async (_input, contactState) => Object.assign(contactState, mockSuppression.state)),
  };
});
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
// Vision + storage seams of the shared assessment pipeline.
const mockLadder = jest.fn();
jest.mock('../services/lawn-diagnostic-analyze', () => {
  const actual = jest.requireActual('../services/lawn-diagnostic-analyze');
  return { ...actual, runFindingsLadder: (...args) => mockLadder(...args), applyWriterSummary: jest.fn(async () => {}) };
});
jest.mock('../services/lawn-assessment', () => ({ getSeason: () => 'peak' }));
const mockIdentifyPest = jest.fn();
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...args) => mockIdentifyPest(...args) };
});
jest.mock('../utils/funnel-photos', () => ({ storeFunnelPhotos: jest.fn(async () => {}) }));
const mockGetPhotoBuffer = jest.fn(async () => ({ buffer: Buffer.from('raw'), contentType: 'image/jpeg' }));
jest.mock('../services/photos', () => ({ getPhotoBuffer: (...args) => mockGetPhotoBuffer(...args) }));
jest.mock('sharp', () => jest.fn(() => ({
  rotate: jest.fn().mockReturnThis(),
  resize: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('resized')),
})));

const logger = require('../services/logger');
const { PEST_LIBRARY } = require('../services/pest-identification');
const { countSegments } = require('../services/messaging/segment-counter');
const { CONDITION_LABEL_VALUES } = require('../services/lawn-diagnostic-report');
const triage = require('../services/photo-text-triage');

// The webhook's two steps, in order (candidacy is awaited before the legacy
// draft step; the run is detached after it).
const mockLegacyFallback = jest.fn(async () => {});
async function triageInboundPhotoText(args) {
  return triage.runPhotoTriage(await triage.assessPhotoTriageCandidacy(args), { legacyFallback: mockLegacyFallback });
}
const AMBIGUOUS = 'Look at this by the driveway';
const { buildDraftText, dailyCap, imageMedia, teaserOutcome } = triage._test;

const MESSAGE_ID = 'dddddddd-eeee-4fff-8000-111111111111';
const INBOUND_KEY = 'sms-media/inbound/abc123';
const CUSTOMER = { id: 'ffffffff-0000-4111-8222-333333333333', first_name: 'Dana', last_name: 'Reed' };
const MEDIA = [{ key: INBOUND_KEY, contentType: 'image/jpeg', size: 1234 }];

const LADDER_RESULT = {
  findings: [
    { finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', observed_evidence: ['RAW MODEL OBSERVATION sunny edge browning'], negative_evidence: [], confirmation_step: 'INTERNAL: float test at margin' },
  ],
  findingsSource: 'multimodel',
  fallbackReason: null,
  provenance: { challenge: { passed: true }, perceptionModel: 'perception-model-sentinel', challengeModel: 'challenge-model-sentinel', writerModel: null },
};
const GHOST_ANT = PEST_LIBRARY.find((e) => e.slug === 'ghost-ant');
const PEST_RESULT = {
  ok: true,
  identification: { entry: GHOST_ANT, confidence: 'high', category: 'insect', contested: false },
  perPhoto: [{ entry: GHOST_ANT, confidence: 'high', category: 'insect', agreement: 'match', model_count: 2, observations: ['RAW MODEL OBSERVATION pale legs'], distinguishing_features: [], alternate_slugs: [] }],
  observations: ['RAW MODEL OBSERVATION pale legs'],
  distinguishing_features: [],
  alternate_slugs: [],
};

function input(overrides = {}) {
  return {
    inboundTouchpoint: { message: { id: MESSAGE_ID } },
    smsLogEntry: { id: 'sms-log-1' },
    body: 'what is this in my lawn?',
    from: '+12025550101',
    numberType: 'location',
    isAiNumber: false,
    customer: CUSTOMER,
    media: MEDIA,
    ...overrides,
  };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  mockSuppression.state = { suppressionLoaded: true };
  process.env = { ...savedEnv, GATE_PHOTO_TRIAGE: 'true' };
  delete process.env.PHOTO_TRIAGE_DAILY_CAP;
  delete process.env.PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP;
  delete process.env.ADAM_PHONE;
  mockState.message = { id: MESSAGE_ID, direction: 'inbound', conversation_id: 'conv-1', media: JSON.stringify(MEDIA) };
  mockState.conversationCustomerId = CUSTOMER.id;
  mockState.customerRow = CUSTOMER;
  mockLadder.mockResolvedValue(LADDER_RESULT);
  mockIdentifyPest.mockResolvedValue(PEST_RESULT);
});
afterAll(() => { process.env = savedEnv; });

describe('gate', () => {
  test('gate off = no-op: no DB read, no model call, no vision', async () => {
    delete process.env.GATE_PHOTO_TRIAGE;
    await expect(triageInboundPhotoText(input())).resolves.toEqual({ status: 'skipped', reason: 'gate_off' });
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockLadder).not.toHaveBeenCalled();
    expect(mockIdentifyPest).not.toHaveBeenCalled();
  });
});

describe('guards (all before any paid call)', () => {
  async function expectSkip(overrides, reason) {
    await expect(triageInboundPhotoText(input(overrides))).resolves.toEqual({ status: 'skipped', reason });
    expect(mockLadder).not.toHaveBeenCalled();
    expect(mockIdentifyPest).not.toHaveBeenCalled();
    expect(mockState.inserts.message_drafts).toBeUndefined();
  }

  test('no image media (none, non-image, unsigned key)', async () => {
    await expectSkip({ media: [] }, 'no_image');
    await expectSkip({ media: [{ key: INBOUND_KEY, contentType: 'video/mp4' }] }, 'no_image');
    await expectSkip({ media: [{ key: 'elsewhere/abc', contentType: 'image/jpeg' }] }, 'no_image');
    await expectSkip({ media: [{ providerUrl: 'https://api.twilio.com/x', contentType: 'image/jpeg' }] }, 'no_image');
  });

  test('tech lines and the AI assistant line are excluded', async () => {
    await expectSkip({ numberType: 'tech_line' }, 'excluded_line');
    await expectSkip({ isAiNumber: true }, 'excluded_line');
  });

  test('internal senders: a Waves number, the owner phone, a technician phone', async () => {
    const numbers = require('../config/twilio-numbers');
    await expectSkip({ from: numbers.tollFree.number }, 'internal_sender');
    process.env.ADAM_PHONE = '+19415550199';
    await expectSkip({ from: '(941) 555-0199' }, 'internal_sender');
    mockState.tech = { id: 'tech-1' };
    await expectSkip({}, 'internal_sender');
  });

  test('opt-out: an active suppression row, sms_enabled=false, and unknown suppression state all skip', async () => {
    mockSuppression.state = { suppressionLoaded: true, suppression: { reason: 'opt_out_keyword', created_at: 'x' } };
    await expectSkip({}, 'opted_out');
    mockSuppression.state = { suppressionLookupFailed: true };
    await expectSkip({}, 'opted_out');
    mockSuppression.state = { suppressionLoaded: true };
    mockState.prefs = { sms_enabled: false };
    await expectSkip({}, 'opted_out');
  });

  test('a caption that is not a diagnosis question skips', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'none' } });
    await expectSkip({ body: 'Here is the receipt you asked for' }, 'not_diagnosis');
  });

  test('a conversation with a pending draft skips before the claim', async () => {
    mockState.pendingDraft = [{ id: 'other-draft' }];
    await expectSkip({}, 'pending_draft');
    expect(mockDb.transaction).not.toHaveBeenCalled();
    // The contact match covers the inbound anchor, flagged phone, and customer.
    const kinds = mockState.pendingWhere.map(([method]) => method);
    expect(kinds).toEqual(['whereRaw', 'orWhereRaw', 'orWhere']);
    expect(mockState.pendingWhere[2]).toEqual(['orWhere', 'md.customer_id', CUSTOMER.id]);
  });

  test('idempotent on the message: an already-stamped message is never analyzed again', async () => {
    mockState.alreadyTriaged = true;
    await expectSkip({}, 'already_triaged');
  });

  test('daily cap: default 20, env override, and 0 turns the lane off', async () => {
    expect(dailyCap()).toBe(20);
    mockState.counts.photo_triage_at = 20;
    await expectSkip({}, 'cap_reached');
    process.env.PHOTO_TRIAGE_DAILY_CAP = '25';
    expect(dailyCap()).toBe(25);
    resetState();
    mockState.message = { id: MESSAGE_ID, direction: 'inbound', media: JSON.stringify(MEDIA) };
    process.env.PHOTO_TRIAGE_DAILY_CAP = '0';
    await expectSkip({}, 'cap_reached');
    process.env.PHOTO_TRIAGE_DAILY_CAP = 'lots';
    expect(dailyCap()).toBe(20);
  });
});

describe('paid classifier budget (captions the regex cannot place)', () => {
  beforeEach(() => mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'lawn' } }));

  test('vision budget spent → the classifier is never called', async () => {
    mockState.counts.photo_triage_at = 20;
    await expect(triageInboundPhotoText(input({ body: AMBIGUOUS })))
      .resolves.toEqual({ status: 'skipped', reason: 'cap_reached' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockState.updates).toEqual([]);
  });

  test('pending draft → the classifier is never called', async () => {
    mockState.pendingDraft = [{ id: 'other-draft' }];
    await expect(triageInboundPhotoText(input({ body: AMBIGUOUS })))
      .resolves.toEqual({ status: 'skipped', reason: 'pending_draft' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('budget available → classifier slot claimed, model called once, then the vision slot', async () => {
    const result = await triageInboundPhotoText(input({ body: AMBIGUOUS }));
    expect(result).toMatchObject({ status: 'drafted', type: 'lawn' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockState.updates.map((u) => u.patch)).toEqual([
      { photo_triage_classified_at: 'NOW' },
      { photo_triage_at: 'NOW' },
    ]);
    expect(JSON.parse(mockState.inserts.message_drafts[0].flags).classifier_method).toBe('ai');
  });

  test('a classifier "no" spends a classifier slot but never a vision slot', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { subject: 'none' } });
    await expect(triageInboundPhotoText(input({ body: AMBIGUOUS })))
      .resolves.toEqual({ status: 'skipped', reason: 'not_diagnosis' });
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_classified_at: 'NOW' }]);
  });

  test('classifier cap reached → no model call, no vision; defaults to the vision cap', async () => {
    expect(dailyCap('classifier')).toBe(20);
    process.env.PHOTO_TRIAGE_DAILY_CAP = '7';
    expect(dailyCap('classifier')).toBe(7);
    process.env.PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP = '3';
    expect(dailyCap('classifier')).toBe(3);
    mockState.counts.photo_triage_classified_at = 3;
    await expect(triageInboundPhotoText(input({ body: AMBIGUOUS })))
      .resolves.toEqual({ status: 'skipped', reason: 'classifier_cap_reached' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockLadder).not.toHaveBeenCalled();
    expect(mockState.updates).toEqual([]);
  });

  test('a regex fast-path caption never touches the classifier budget', async () => {
    mockState.counts.photo_triage_classified_at = 999;
    await expect(triageInboundPhotoText(input())).resolves.toMatchObject({ status: 'drafted' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('inbound hook end to end (mocked S3 + vision)', () => {
  test('lawn: claims the message, runs the shared pipeline as auto_triage, parks ONE pending draft', async () => {
    const result = await triageInboundPhotoText(input());
    expect(result).toEqual({ status: 'drafted', draftId: 'draft-1', assessmentId: 'assess-1', type: 'lawn' });

    // Claim stamped the inbound message before the vision call (under the
    // global cap lock); the draft parked under the per-contact lock.
    expect(mockState.updates).toEqual([{ table: 'messages', patch: { photo_triage_at: 'NOW' } }]);
    expect(mockState.raws.map(([, bindings]) => bindings)).toEqual([
      ['photo_triage_daily_cap'],
      // Keyed by customer when the text resolved to one (else the phone).
      ['photo_triage_contact', `customer:${CUSTOMER.id}`],
    ]);
    // S3 fetch of THIS message's own key, then the lawn ladder.
    expect(mockGetPhotoBuffer).toHaveBeenCalledWith(INBOUND_KEY);
    expect(mockLadder).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPest).not.toHaveBeenCalled();

    const [assessment] = mockState.inserts.lawn_diagnostics;
    expect(assessment).toMatchObject({ source: 'auto_triage', mode: 'prospect', status: 'analyzed', customer_id: CUSTOMER.id });
    expect(JSON.parse(assessment.ai_analysis).provenance.source).toBe('auto_triage');

    const [draft] = mockState.inserts.message_drafts;
    expect(draft).toMatchObject({
      sms_log_id: 'sms-log-1',
      customer_id: CUSTOMER.id,
      intent: 'photo_triage',
      status: 'pending',
      inbound_message: 'what is this in my lawn?',
    });
    expect(JSON.parse(draft.flags)).toEqual({
      origin: 'photo_triage',
      assessment_type: 'lawn',
      assessment_id: 'assess-1',
      message_id: MESSAGE_ID,
      classifier_method: 'regex',
    });
    expect(draft.draft_response).toBe(
      "Thanks for the photo, Dana. From what we can see, it's consistent with chinch bug activity. Want us to come take a closer look and quote treatment?",
    );
    expect(draft.draft_response).not.toMatch(/RAW MODEL|INTERNAL|https?:|www\./i);
    expect(countSegments(draft.draft_response).segmentCount).toBeLessThanOrEqual(2);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('pest: empty caption runs the pest identifier; copy is the library-generic teaser label only', async () => {
    const result = await triageInboundPhotoText(input({ body: '' }));
    expect(result).toMatchObject({ status: 'drafted', type: 'pest' });
    expect(mockState.inserts.pest_identifications[0].source).toBe('auto_triage');
    const [draft] = mockState.inserts.message_drafts;
    expect(draft.draft_response).toContain("it's consistent with an ant species.");
    // The species name is withheld pre-capture exactly like the public teaser.
    expect(draft.draft_response).not.toMatch(/ghost/i);
    expect(draft.draft_response).not.toMatch(/RAW MODEL/);
    expect(draft.inbound_message).toBeNull();
  });

  test('a pending draft that appears during the vision call keeps the assessment but parks no draft', async () => {
    mockState.pendingDraft = [null, { id: 'raced' }];
    await expect(triageInboundPhotoText(input())).resolves.toEqual({ status: 'skipped', reason: 'pending_draft' });
    expect(mockState.inserts.lawn_diagnostics).toHaveLength(1);
    expect(mockState.inserts.message_drafts).toBeUndefined();
  });

  test('a failure BEFORE paid analysis (S3 fetch refused) releases the vision slot', async () => {
    mockGetPhotoBuffer.mockRejectedValueOnce(new Error('S3 timeout'));
    await expect(triageInboundPhotoText(input())).resolves.toEqual({ status: 'skipped', reason: 'assessment_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(
      new RegExp(`^\\[photo-triage\\] assessment failed for message ${MESSAGE_ID}; vision slot released: `),
    ));
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }, { photo_triage_at: null }]);
    expect(mockLadder).not.toHaveBeenCalled();
  });

  test('a thrown failure BEFORE paid analysis releases the vision slot', async () => {
    const candidacy = await triage.assessPhotoTriageCandidacy(input());
    mockState.messageLookupFails = true;
    await expect(triage.runPhotoTriage(candidacy)).resolves.toEqual({ status: 'skipped', reason: 'assessment_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('vision slot released: messages lookup timeout'));
    expect(mockState.updates.at(-1).patch).toEqual({ photo_triage_at: null });
  });

  test('a refusal AFTER paid analysis started (vision unavailable) keeps the slot spent', async () => {
    mockIdentifyPest.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    await expect(triageInboundPhotoText(input({ body: 'bugs everywhere' })))
      .resolves.toEqual({ status: 'skipped', reason: 'assessment_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(
      `[photo-triage] assessment failed for message ${MESSAGE_ID}; vision slot kept (analysis started):`,
    ));
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }]);
    expect(mockState.inserts.message_drafts).toBeUndefined();
  });

  test('a throw AFTER paid analysis started (ladder error) keeps the slot spent', async () => {
    mockLadder.mockRejectedValue(new Error('unusable model response'));
    await expect(triageInboundPhotoText(input())).resolves.toEqual({ status: 'skipped', reason: 'assessment_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('vision slot kept (analysis started): unusable model response'));
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }]);
  });

  test('a failed draft insert AFTER paid analysis keeps the slot spent and names the kept assessment', async () => {
    mockState.draftInsertFails = true;
    await expect(triageInboundPhotoText(input())).resolves.toEqual({ status: 'skipped', reason: 'draft_failed' });
    expect(logger.error).toHaveBeenCalledWith(
      `[photo-triage] draft failed for message ${MESSAGE_ID}; lawn assessment assess-1 kept: drafts table unavailable`,
    );
    // Never cleared: clearing would let repeated draft failures exceed the
    // daily cap and re-analyze the same photos.
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }]);
    expect(mockState.inserts.lawn_diagnostics).toHaveLength(1);
  });

  test('the vision slot is reserved at candidacy: losing it means not a candidate (legacy path runs)', async () => {
    mockState.alreadyTriaged = true; // the conditional stamp matches no row
    const candidacy = await triage.assessPhotoTriageCandidacy(input());
    expect(candidacy).toEqual({ candidate: false, reason: 'already_triaged' });
    expect(mockLadder).not.toHaveBeenCalled();
  });

  test('a won reservation is taken before candidacy returns; the run claims nothing more', async () => {
    const candidacy = await triage.assessPhotoTriageCandidacy(input());
    expect(candidacy.candidate).toBe(true);
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }]);
    await triage.runPhotoTriage(candidacy);
    expect(mockState.updates.map((u) => u.patch)).toEqual([{ photo_triage_at: 'NOW' }]);
  });

  test('terminal failures hand the text back to the legacy draft; success and pending-draft skips do not', async () => {
    mockIdentifyPest.mockResolvedValueOnce({ ok: false, reason: 'vision_unavailable' });
    await triageInboundPhotoText(input({ body: 'bugs everywhere' }));
    expect(mockLegacyFallback).toHaveBeenCalledTimes(1);

    mockGetPhotoBuffer.mockRejectedValueOnce(new Error('S3 timeout'));
    await triageInboundPhotoText(input());
    expect(mockLegacyFallback).toHaveBeenCalledTimes(2);

    mockState.draftInsertFails = true;
    await triageInboundPhotoText(input());
    expect(mockLegacyFallback).toHaveBeenCalledTimes(3);
    mockState.draftInsertFails = false;

    await expect(triageInboundPhotoText(input())).resolves.toMatchObject({ status: 'drafted' });
    mockState.pendingDraft = [null, { id: 'raced' }];
    await expect(triageInboundPhotoText(input())).resolves.toMatchObject({ reason: 'pending_draft' });
    expect(mockLegacyFallback).toHaveBeenCalledTimes(3);
  });

  test('an unlinked sender locks on the phone', async () => {
    await triageInboundPhotoText(input({ customer: null }));
    expect(mockState.raws.at(-1)[1]).toEqual(['photo_triage_contact', '2025550101']);
  });

  test('never logs the phone number or the message body', async () => {
    await triageInboundPhotoText(input());
    const logged = [...logger.info.mock.calls, ...logger.error.mock.calls, ...logger.warn.mock.calls].flat().join('\n');
    expect(logged).not.toContain('2025550101');
    expect(logged).not.toContain('what is this');
  });
});

describe('draft text builder', () => {
  const act = (label) => ({ kind: 'actionable', label });
  const ok = (label) => ({ kind: 'harmless', label });
  const NONE = { kind: 'none' };

  test('one closing line per outcome: actionable offers a quote, harmless says no treatment, none just offers a look', () => {
    expect(buildDraftText({ firstName: 'Dana', outcome: act('weed pressure') })).toBe(
      "Thanks for the photo, Dana. From what we can see, it's consistent with weed pressure. Want us to come take a closer look and quote treatment?",
    );
    expect(buildDraftText({ firstName: 'Dana', outcome: ok('nothing to worry about') })).toBe(
      "Thanks for the photo, Dana. From what we can see, it's nothing to worry about, so no treatment is needed. Reply if you'd like us to take a look anyway.",
    );
    expect(buildDraftText({ firstName: 'Dana', outcome: NONE })).toBe('Thanks for the photo, Dana. Want us to take a look?');
    // Only the actionable outcome ever mentions a quote or treatment offer.
    expect(buildDraftText({ firstName: 'Dana', outcome: ok('a healthy lawn') })).not.toMatch(/quote/i);
    expect(buildDraftText({ firstName: 'Dana', outcome: NONE })).not.toMatch(/quote|treatment/i);
  });

  test('promises nothing Approve does not send: no report, no link', () => {
    for (const outcome of [NONE, act('weed pressure'), ok('a healthy lawn')]) {
      expect(buildDraftText({ firstName: 'Dana', outcome })).not.toMatch(/report|link|https?:|shortly/i);
    }
  });

  test('every lawn label the teaser can publish fits two segments with a long first name, and carries no link', () => {
    for (const label of [...CONDITION_LABEL_VALUES, 'a healthy lawn']) {
      for (const outcome of [act(label), ok(label)]) {
        const text = buildDraftText({ firstName: 'Bartholomew-Alexander', outcome });
        expect(countSegments(text).segmentCount).toBeLessThanOrEqual(2);
        expect(text).not.toMatch(/https?:|www\.|\.com/i);
      }
    }
  });

  test('every pest teaser label fits two segments in either outcome', () => {
    const { GROUP_GENERIC, CATEGORY_GENERIC } = require('../services/pest-identification')._test;
    for (const label of [...Object.values(GROUP_GENERIC), ...Object.values(CATEGORY_GENERIC)]) {
      for (const outcome of [act(label), ok(label)]) {
        expect(countSegments(buildDraftText({ firstName: 'Bartholomew-Alexander', outcome })).segmentCount).toBeLessThanOrEqual(2);
      }
    }
  });

  test('first name only, sanitized; dropped when it would push past two segments', () => {
    expect(buildDraftText({ firstName: 'Dana Reed', outcome: NONE })).toBe('Thanks for the photo, Dana. Want us to take a look?');
    expect(buildDraftText({ firstName: '12345', outcome: NONE })).toMatch(/^Thanks for the photo\. /);
    // A non-GSM letter flips the whole text to UCS-2 (67 chars/segment), so
    // the name goes rather than the copy running to a third segment.
    const long = buildDraftText({ firstName: 'Łukasz', outcome: act('large patch (fungal) activity') });
    expect(long.startsWith('Thanks for the photo. ')).toBe(true);
    expect(countSegments(long).segmentCount).toBeLessThanOrEqual(2);
  });

  test('teaser outcomes come only from the allowlists, never the raw contract', () => {
    const lawnRow = (findings, score) => ({
      report_contract: JSON.stringify({ diagnosis: { findings } }), overall_score: score, created_at: new Date(),
    });
    // A low-confidence cause downgrades to the generic label.
    expect(teaserOutcome('lawn', lawnRow([{ name: 'Talstar-resistant chinch bugs RAW', confidence: 'low' }], 30)))
      .toEqual({ kind: 'actionable', label: 'general lawn stress' });
    // A clean finding, or no finding on a Healthy score, is harmless.
    expect(teaserOutcome('lawn', lawnRow([{ name: 'Healthy, dense turf', confidence: 'high' }], 85)))
      .toEqual({ kind: 'harmless', label: 'a healthy lawn' });
    expect(teaserOutcome('lawn', lawnRow([], 85))).toEqual({ kind: 'harmless', label: 'a healthy lawn' });
    expect(teaserOutcome('lawn', lawnRow([], 30))).toEqual({ kind: 'none' });

    const pestRow = (identification) => ({ report_contract: JSON.stringify({ identification }) });
    expect(teaserOutcome('pest', pestRow({ slug: 'not-a-real-slug', category: 'insect' })))
      .toEqual({ kind: 'actionable', label: 'an insect' });
    expect(teaserOutcome('pest', pestRow({ category: 'not_a_pest' })))
      .toEqual({ kind: 'harmless', label: 'nothing to worry about' });
    // A library entry flagged not_a_pest (beneficial species, lovebugs) is
    // harmless even when the model called the category "insect".
    expect(teaserOutcome('pest', pestRow({ slug: 'beneficial', category: 'insect', confidence: 'high' })))
      .toMatchObject({ kind: 'harmless' });
    expect(teaserOutcome('pest', pestRow({ slug: 'lovebug', category: 'insect', confidence: 'high' })))
      .toMatchObject({ kind: 'harmless' });
  });
});


test('imageMedia caps at the pipeline photo limit', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ key: `sms-media/inbound/k${i}`, mimeType: 'image/png' }));
  expect(imageMedia(many)).toHaveLength(5);
});
