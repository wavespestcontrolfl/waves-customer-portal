'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20261128030000_message_drafts_post_visit_revision');
const rollbackGuardMigration = require('../models/migrations/20261128030500_message_drafts_post_visit_revision_rollback_guard');
const { smsPostVisitRedraftLive } = require('../config/feature-gates');
const {
  POST_VISIT_TRIGGER,
  HOUSE_VOICE_DRAFTER,
  etDayBounds,
  lastTenPhone,
  inboundHasMedia,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
} = require('../services/sms-post-visit-redraft');

function chain({ first = null, result = [] } = {}) {
  const q = {};
  ['where', 'whereNot', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNotIn', 'orderBy', 'offset', 'limit', 'select']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

function makeDb(queues) {
  const map = new Map(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  const fn = jest.fn((table) => {
    const base = String(table).split(/\s+/)[0];
    const q = map.get(base);
    if (!q || !q.length) throw new Error(`Unexpected table read: ${table}`);
    return q.shift();
  });
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
}

describe('GATE_SMS_POST_VISIT_REDRAFT gate reader', () => {
  let savedRedraft;
  let savedB1;
  let savedReal;
  beforeEach(() => {
    savedRedraft = process.env.GATE_SMS_POST_VISIT_REDRAFT;
    savedB1 = process.env.GATE_SMS_PROMPT_B1;
    savedReal = process.env.GATE_SMS_REAL_ANSWERS;
    delete process.env.GATE_SMS_POST_VISIT_REDRAFT;
    delete process.env.GATE_SMS_PROMPT_B1;
    delete process.env.GATE_SMS_REAL_ANSWERS;
  });
  afterEach(() => {
    if (savedRedraft === undefined) delete process.env.GATE_SMS_POST_VISIT_REDRAFT;
    else process.env.GATE_SMS_POST_VISIT_REDRAFT = savedRedraft;
    if (savedB1 === undefined) delete process.env.GATE_SMS_PROMPT_B1;
    else process.env.GATE_SMS_PROMPT_B1 = savedB1;
    if (savedReal === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = savedReal;
  });

  test('is strict === "true", dark by default, and requires smsPromptB1Live() so findings actually load', () => {
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_POST_VISIT_REDRAFT = '1';
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_POST_VISIT_REDRAFT = 'true';
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_PROMPT_B1 = 'true';
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    expect(smsPostVisitRedraftLive()).toBe(true);
  });
});

describe('migrations', () => {
  test('adds supersedes_draft_id, draft_trigger and partial unique index, and down() drops them', async () => {
    const added = [];
    const dropped = [];
    const raws = [];
    const knex = {
      schema: {
        hasTable: jest.fn(async () => true),
        hasColumn: jest.fn(async () => false),
        alterTable: jest.fn(async (_t, fn) => {
          fn({
            uuid: (col) => {
              added.push(col);
              return { nullable: () => ({ references: () => ({ inTable: () => ({ onDelete: () => {} }) }) }) };
            },
            string: (col) => {
              added.push(col);
              return { notNullable: () => ({ defaultTo: () => {} }) };
            },
            dropColumn: (col) => dropped.push(col),
          });
        }),
      },
      raw: jest.fn(async (sql) => { raws.push(sql); }),
    };

    await migration.up(knex);
    expect(added).toEqual(['supersedes_draft_id', 'draft_trigger']);
    expect(raws[0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_post_visit_revision_uniq');

    knex.schema.hasColumn.mockResolvedValue(true);
    await migration.down(knex);
    expect(raws[1]).toContain('DROP INDEX IF EXISTS message_drafts_post_visit_revision_uniq');
    expect(dropped).toEqual(['supersedes_draft_id', 'draft_trigger']);
  });

  test('rollback guard refuses down() when post_visit_closeout revisions exist and allows when none exist', async () => {
    const mkKnex = (existingRow) => {
      const fn = jest.fn(() => chain({ first: existingRow }));
      fn.schema = {
        hasTable: jest.fn(async () => true),
        hasColumn: jest.fn(async () => true),
      };
      return fn;
    };
    await expect(rollbackGuardMigration.up()).resolves.toBeUndefined();
    await expect(rollbackGuardMigration.down(mkKnex({ id: 'rev-1' }))).rejects.toThrow(/post_visit_closeout/i);
    await expect(rollbackGuardMigration.down(mkKnex(null))).resolves.toBeUndefined();
  });
});

describe('pure helpers', () => {
  test('etDayBounds returns valid ET midnight-to-midnight bounds', () => {
    const { day, start, end } = etDayBounds('2026-11-27');
    expect(day).toBe('2026-11-27');
    expect(start.toISOString()).toBe('2026-11-27T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-28T05:00:00.000Z');
  });

  test('lastTenPhone returns 10 digits for US and international numbers', () => {
    expect(lastTenPhone('+1 (941) 555-0199')).toBe('9415550199');
    expect(lastTenPhone('+44 20 7946 0958')).toBe('2079460958');
    expect(lastTenPhone('12345')).toBeNull();
  });

  test('inboundHasMedia fails closed on null/missing/malformed metadata and returns false only for confirmed zero media', () => {
    expect(inboundHasMedia(null)).toBe(true);
    expect(inboundHasMedia({})).toBe(true);
    expect(inboundHasMedia('{bad-json')).toBe(true);
    expect(inboundHasMedia({ media: [] })).toBe(false);
    expect(inboundHasMedia({ media: ['https://example.com/photo.jpg'] })).toBe(true);
  });
});

describe('findEligibleInboundForPostVisitRedraft (via canonical pending conversations)', () => {
  const INBOUND = {
    id: 'sms-in-1',
    from_phone: '+19415550199',
    message_body: 'Did the tech spray the back patio?',
    created_at: new Date('2026-11-27T14:00:00Z'),
    metadata: { media: ['https://example.com/patio.jpg'] },
  };
  const PENDING_ROW = {
    id: 'msg-canonical-1',
    source: 'canonical',
    legacy_id: 'sms-in-1',
    peer: '9415550199',
    created_at: INBOUND.created_at,
  };
  const PRIOR_DRAFT = {
    id: 'draft-orig-1',
    created_at: new Date('2026-11-27T14:01:00Z'),
    intent: 'customer_issue_needs_review',
    intent_confidence: 0.92,
    scheduling_intent: true,
  };

  test('uses loadPendingSmsConversations, preserves intent/schedulingIntent/hasMedia, and requires house_voice drafter', async () => {
    const priorDraftQ = chain({ first: PRIOR_DRAFT });
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [priorDraftQ, chain({ first: null })],
    });
    const loadPendingSmsConversations = jest.fn(async () => [PENDING_ROW]);

    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, { threadHasLiveAnswer: jest.fn(async () => null), loadPendingSmsConversations });

    expect(loadPendingSmsConversations).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      includeLegacyOnly: true,
      dbh,
    }));
    expect(priorDraftQ.where).toHaveBeenCalledWith({
      sms_log_id: 'sms-in-1',
      drafter: HOUSE_VOICE_DRAFTER,
      draft_trigger: 'inbound',
    });
    expect(res).toEqual({
      smsLogId: 'sms-in-1',
      fromPhone: '+19415550199',
      inboundMessage: 'Did the tech spray the back patio?',
      inboundAt: INBOUND.created_at,
      priorDraftId: 'draft-orig-1',
      intent: { intent: 'customer_issue_needs_review', confidence: 0.92 },
      schedulingIntent: true,
      hasMedia: true,
    });
  });

  test('returns null when loadPendingSmsConversations resolved the thread via phone callback or staff action', async () => {
    const dbh = makeDb({});
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, { loadPendingSmsConversations: async () => [] });
    expect(res).toBeNull();
  });

  test('returns null when an automated outbound reply already answered on that phone thread', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: { id: 'sms-auto-1' } })],
      message_drafts: [],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, {
      threadHasLiveAnswer: jest.fn(async () => null),
      loadPendingSmsConversations: async () => [PENDING_ROW],
    });
    expect(res).toBeNull();
  });
});

describe('draftPostVisitRevisionIfEligible', () => {
  const INBOUND = {
    id: 'sms-in-2',
    from_phone: '+19415550188',
    message_body: 'What did you find in the garage?',
    created_at: new Date('2026-11-27T15:00:00Z'),
    metadata: { media: [] },
  };
  const PENDING = { id: 'msg-2', source: 'canonical', legacy_id: 'sms-in-2', created_at: INBOUND.created_at };
  const PRIOR = {
    id: 'draft-orig-2',
    created_at: new Date('2026-11-27T15:01:00Z'),
    intent: 'service_question',
    intent_confidence: 0.88,
    scheduling_intent: false,
  };

  test('returns gate_off with ZERO DB queries when GATE_SMS_POST_VISIT_REDRAFT is off ($0 cost)', async () => {
    const dbh = jest.fn();
    const draftFn = jest.fn();
    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => false },
      draftFn,
    });
    expect(res).toEqual({ skipped: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
    expect(draftFn).not.toHaveBeenCalled();
  });

  test('claims per-message lock, rechecks canonical pending view inside lock, passes liveEta:false & serviceRecordId', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null }), chain({ first: null })],
      customers: [chain({ result: [{ id: 'cust-2', first_name: 'Sam', city: 'Sarasota' }] })],
    });
    const draftFn = jest.fn(async () => 'draft-rev-2');
    const lockFn = jest.fn(async (_name, fn) => fn());
    const loadPendingFn = jest.fn(async () => [PENDING]);

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      serviceRecordId: 'rec-focus-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn,
      loadPendingFn,
      threadHasLiveAnswerFn: async () => null,
    });

    expect(lockFn).toHaveBeenCalledWith('sms-post-visit-redraft:sms-in-2', expect.any(Function), { recordHealth: false });
    expect(loadPendingFn).toHaveBeenCalledTimes(2);
    expect(loadPendingFn).toHaveBeenLastCalledWith(expect.objectContaining({ customerId: 'cust-2', dbh }));
    expect(res).toEqual({ drafted: true, draftId: 'draft-rev-2', supersedesDraftId: 'draft-orig-2' });
    expect(draftFn).toHaveBeenCalledWith(expect.objectContaining({
      smsLogId: 'sms-in-2',
      intent: { intent: 'service_question', confidence: 0.88 },
      schedulingIntent: false,
      hasMedia: false,
      draftTrigger: POST_VISIT_TRIGGER,
      supersedesDraftId: 'draft-orig-2',
      serviceRecordId: 'rec-focus-2',
      liveEta: false,
      skipAutoSend: true,
    }));
  });

  test('skips paid draft when phone ownership changed or became shared before lock', async () => {
    const sharedDb = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null }), chain({ first: null })],
      customers: [chain({ result: [{ id: 'cust-2', first_name: 'Sam' }, { id: 'cust-other', first_name: 'Pat' }] })],
    });
    const draftFn = jest.fn();
    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh: sharedDb,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn: async (_name, fn) => fn(),
      loadPendingFn: async () => [PENDING],
      threadHasLiveAnswerFn: async () => null,
    });
    expect(res).toEqual({ skipped: 'phone_ownership_changed' });
    expect(draftFn).not.toHaveBeenCalled();
  });

  test('skips paid draft when staff resolves thread via callback/action before lock is acquired', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null }), chain({ first: null })],
      customers: [chain({ result: [{ id: 'cust-2', first_name: 'Sam' }] })],
    });
    const draftFn = jest.fn();
    const loadPendingFn = jest.fn()
      .mockResolvedValueOnce([PENDING])
      .mockResolvedValueOnce([]); // resolved by phone callback before lock!
    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn: async (_name, fn) => fn(),
      loadPendingFn,
      threadHasLiveAnswerFn: async () => null,
    });
    expect(res).toEqual({ skipped: 'resolved_before_lock' });
    expect(draftFn).not.toHaveBeenCalled();
  });

  test('retries bounded capacity skips (no_connection) before succeeding or reporting lock_unavailable', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null }), chain({ first: null })],
      customers: [chain({ result: [{ id: 'cust-2', first_name: 'Sam' }] })],
    });
    const draftFn = jest.fn(async () => 'draft-rev-retry');
    const sleepFn = jest.fn(async () => {});
    const lockFn = jest.fn()
      .mockResolvedValueOnce({ skipped: true, reason: 'no_connection' })
      .mockImplementationOnce(async (_name, fn) => fn());

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      serviceRecordId: 'rec-retry',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn,
      sleepFn,
      loadPendingFn: async () => [PENDING],
      threadHasLiveAnswerFn: async () => null,
    });
    expect(lockFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ drafted: true, draftId: 'draft-rev-retry', supersedesDraftId: 'draft-orig-2' });
  });
});

describe('findPostVisitRedraftCandidates (read-only discovery helper)', () => {
  test('filters to completed non-backfill non-incomplete records and pages past ineligible closeouts', async () => {
    const inbound = {
      id: 'sms-in-4',
      from_phone: '+19415550166',
      message_body: 'Did you treat the shed?',
      created_at: new Date('2026-11-27T13:00:00Z'),
      metadata: { media: [] },
    };
    const prior = {
      id: 'draft-orig-4',
      created_at: new Date('2026-11-27T13:01:00Z'),
      intent: 'GENERAL',
      intent_confidence: 0.8,
      scheduling_intent: false,
    };
    const page1 = chain({
      result: [
        { id: 'rec-1', customer_id: 'cust-1', created_at: new Date('2026-11-27T17:00:00Z') },
        { id: 'rec-2', customer_id: 'cust-2', created_at: new Date('2026-11-27T16:30:00Z') },
      ],
    });
    const page2 = chain({
      result: [
        { id: 'rec-3', customer_id: 'cust-3', created_at: new Date('2026-11-27T16:00:00Z') },
      ],
    });
    const dbh = makeDb({
      service_records: [page1, page2],
      sms_log: [chain({ first: inbound }), chain({ first: null })],
      message_drafts: [chain({ first: prior }), chain({ first: null })],
    });
    const loadPendingSmsConversations = jest.fn(async ({ customerId }) => (
      customerId === 'cust-3'
        ? [{ id: 'msg-4', source: 'canonical', legacy_id: 'sms-in-4', created_at: inbound.created_at }]
        : []
    ));

    const list = await findPostVisitRedraftCandidates(
      dbh,
      { visitDateET: '2026-11-27', limit: 1, pageSize: 2 },
      { threadHasLiveAnswer: async () => null, loadPendingSmsConversations },
    );
    expect(page1.where).toHaveBeenCalledWith('status', 'completed');
    expect(page1.whereRaw).toHaveBeenCalledWith("COALESCE(structured_notes->>'backfill', 'false') <> 'true'");
    expect(page1.whereRaw).toHaveBeenCalledWith("COALESCE(structured_notes->>'visitOutcome', 'completed') <> 'incomplete'");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ customerId: 'cust-3', serviceRecordId: 'rec-3', smsLogId: 'sms-in-4' });
  });
});

describe('shadow judge baseline isolation', () => {
  test('judgeShadowDrafts filters draft_trigger = inbound using equality filter', async () => {
    const db = require('../models/db');
    const q = {
      leftJoin: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      where: jest.fn(() => q),
      select: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(async () => []),
    };
    db.mockImplementation(() => q);

    const { judgeShadowDrafts } = require('../services/sms-shadow-judge');
    const res = await judgeShadowDrafts({ batchLimit: 5 });
    expect(res.judged).toBe(0);
    expect(q.where).toHaveBeenCalledWith('message_drafts.draft_trigger', 'inbound');
  });
});
