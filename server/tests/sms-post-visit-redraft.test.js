'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20261128030000_message_drafts_post_visit_revision');
const { smsPostVisitRedraftLive } = require('../config/feature-gates');
const {
  POST_VISIT_TRIGGER,
  HOUSE_VOICE_DRAFTER,
  etDayBounds,
  inboundHasMedia,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
} = require('../services/sms-post-visit-redraft');

function chain({ first = null, result = [] } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNotIn', 'orderBy', 'offset', 'limit', 'select']
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
  let saved;
  beforeEach(() => { saved = process.env.GATE_SMS_POST_VISIT_REDRAFT; delete process.env.GATE_SMS_POST_VISIT_REDRAFT; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_SMS_POST_VISIT_REDRAFT;
    else process.env.GATE_SMS_POST_VISIT_REDRAFT = saved;
  });

  test('is strict === "true" and dark by default', () => {
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_POST_VISIT_REDRAFT = '1';
    expect(smsPostVisitRedraftLive()).toBe(false);
    process.env.GATE_SMS_POST_VISIT_REDRAFT = 'true';
    expect(smsPostVisitRedraftLive()).toBe(true);
  });
});

describe('migration 20261128030000_message_drafts_post_visit_revision', () => {
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
    expect(raws[0]).toContain("draft_trigger = 'post_visit_closeout'");

    knex.schema.hasColumn.mockResolvedValue(true);
    await migration.down(knex);
    expect(raws[1]).toContain('DROP INDEX IF EXISTS message_drafts_post_visit_revision_uniq');
    expect(dropped).toEqual(['supersedes_draft_id', 'draft_trigger']);
  });
});

describe('pure helpers', () => {
  test('etDayBounds returns valid ET midnight-to-midnight bounds', () => {
    const { day, start, end } = etDayBounds('2026-11-27');
    expect(day).toBe('2026-11-27');
    expect(start.toISOString()).toBe('2026-11-27T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-28T05:00:00.000Z');
  });

  test('inboundHasMedia detects attachments and fails closed on malformed metadata', () => {
    expect(inboundHasMedia(null)).toBe(false);
    expect(inboundHasMedia({ media: [] })).toBe(false);
    expect(inboundHasMedia({ media: ['https://example.com/photo.jpg'] })).toBe(true);
    expect(inboundHasMedia('{"media":[]}')).toBe(false);
    expect(inboundHasMedia('{bad-json')).toBe(true);
  });
});

describe('findEligibleInboundForPostVisitRedraft', () => {
  const INBOUND = {
    id: 'sms-in-1',
    from_phone: '+19415550199',
    message_body: 'Did the tech spray the back patio?',
    created_at: new Date('2026-11-27T14:00:00Z'),
    metadata: { media: ['https://example.com/patio.jpg'] },
  };
  const PRIOR_DRAFT = {
    id: 'draft-orig-1',
    created_at: new Date('2026-11-27T14:01:00Z'),
    intent: 'customer_issue_needs_review',
    intent_confidence: 0.92,
    scheduling_intent: true,
  };

  test('returns eligible inbound preserving intent, schedulingIntent, hasMedia, and requires house_voice drafter', async () => {
    const priorDraftQ = chain({ first: PRIOR_DRAFT });
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [priorDraftQ, chain({ first: null })],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, { threadHasLiveAnswer: jest.fn(async () => null) });

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

  test('returns null when phone-thread already has a live answer or in-flight reply', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND })],
      message_drafts: [],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, { threadHasLiveAnswer: jest.fn(async () => 'human_answered') });
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
    }, { threadHasLiveAnswer: jest.fn(async () => null) });
    expect(res).toBeNull();
  });

  test('returns null when a post_visit_closeout revision already exists', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR_DRAFT }), chain({ first: { id: 'draft-rev-1' } })],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    }, { threadHasLiveAnswer: jest.fn(async () => null) });
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

  test('claims advisory lock before drafting and forwards intent, schedulingIntent, hasMedia, and skipAutoSend=true', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null }), chain({ first: null })],
      customers: [chain({ first: { id: 'cust-2', first_name: 'Sam', city: 'Sarasota' } })],
    });
    const draftFn = jest.fn(async () => 'draft-rev-2');
    const lockFn = jest.fn(async (_name, fn) => fn());

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn,
      threadHasLiveAnswerFn: async () => null,
    });

    expect(lockFn).toHaveBeenCalledWith('sms-post-visit-redraft:sms-in-2', expect.any(Function));
    expect(res).toEqual({ drafted: true, draftId: 'draft-rev-2', supersedesDraftId: 'draft-orig-2' });
    expect(draftFn).toHaveBeenCalledWith(expect.objectContaining({
      smsLogId: 'sms-in-2',
      intent: { intent: 'service_question', confidence: 0.88 },
      schedulingIntent: false,
      hasMedia: false,
      draftTrigger: POST_VISIT_TRIGGER,
      supersedesDraftId: 'draft-orig-2',
      skipAutoSend: true,
    }));
  });

  test('skips paid draft when another closeout already holds the per-inbound advisory lock', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR }), chain({ first: null })],
      customers: [chain({ first: { id: 'cust-2', first_name: 'Sam' } })],
    });
    const draftFn = jest.fn();
    const lockFn = jest.fn(async () => ({ skipped: true, reason: 'lease_held' }));

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { smsPostVisitRedraftLive: () => true },
      draftFn,
      lockFn,
      threadHasLiveAnswerFn: async () => null,
    });

    expect(res).toEqual({ skipped: 'claim_in_flight' });
    expect(draftFn).not.toHaveBeenCalled();
  });
});

describe('findPostVisitRedraftCandidates (Mac free runner pagination)', () => {
  test('pages past ineligible closeouts until eligible candidates are found', async () => {
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
    // Page 1 (full batch of 2): both customers have no inbound SMS.
    // Page 2 (1 row): customer 3 IS eligible.
    const dbh = makeDb({
      service_records: [
        chain({
          result: [
            { id: 'rec-1', customer_id: 'cust-1', created_at: new Date('2026-11-27T17:00:00Z') },
            { id: 'rec-2', customer_id: 'cust-2', created_at: new Date('2026-11-27T16:30:00Z') },
          ],
        }),
        chain({
          result: [
            { id: 'rec-3', customer_id: 'cust-3', created_at: new Date('2026-11-27T16:00:00Z') },
          ],
        }),
      ],
      sms_log: [
        chain({ first: null }), // cust-1
        chain({ first: null }), // cust-2
        chain({ first: inbound }), // cust-3 inbound
        chain({ first: null }), // cust-3 automated answer
      ],
      message_drafts: [
        chain({ first: prior }),
        chain({ first: null }),
      ],
    });

    const list = await findPostVisitRedraftCandidates(
      dbh,
      { visitDateET: '2026-11-27', limit: 1, pageSize: 2 },
      { threadHasLiveAnswer: async () => null },
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      customerId: 'cust-3',
      serviceRecordId: 'rec-3',
      smsLogId: 'sms-in-4',
      priorDraftId: 'draft-orig-4',
    });
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
