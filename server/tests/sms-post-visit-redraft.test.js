'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20261128030000_message_drafts_post_visit_revision');
const {
  POST_VISIT_TRIGGER,
  etDayBounds,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
} = require('../services/sms-post-visit-redraft');

function chain({ first = null, result = [] } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNotIn', 'orderBy', 'limit', 'select']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

function makeDb(queues) {
  const map = new Map(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  return jest.fn((table) => {
    const base = String(table).split(/\s+/)[0];
    const q = map.get(base);
    if (!q || !q.length) throw new Error(`Unexpected table read: ${table}`);
    return q.shift();
  });
}

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

describe('etDayBounds', () => {
  test('returns valid ET midnight-to-midnight bounds for YYYY-MM-DD input', () => {
    const { day, start, end } = etDayBounds('2026-11-27');
    expect(day).toBe('2026-11-27');
    expect(start.toISOString()).toBe('2026-11-27T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-28T05:00:00.000Z');
  });
});

describe('findEligibleInboundForPostVisitRedraft', () => {
  const INBOUND = {
    id: 'sms-in-1',
    from_phone: '+19415550199',
    message_body: 'Did the tech spray the back patio?',
    created_at: new Date('2026-11-27T14:00:00Z'),
  };
  const PRIOR_DRAFT = {
    id: 'draft-orig-1',
    created_at: new Date('2026-11-27T14:01:00Z'),
  };

  test('returns eligible inbound + priorDraftId when unanswered and unrevised', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR_DRAFT }), chain({ first: null })],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    });
    expect(res).toEqual({
      smsLogId: 'sms-in-1',
      fromPhone: '+19415550199',
      inboundMessage: 'Did the tech spray the back patio?',
      inboundAt: INBOUND.created_at,
      priorDraftId: 'draft-orig-1',
    });
  });

  test('returns null when a human reply already answered the inbound text', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: { id: 'sms-out-1' } })],
      message_drafts: [],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    });
    expect(res).toBeNull();
  });

  test('returns null when no pre-closeout inbound draft exists', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: null })],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    });
    expect(res).toBeNull();
  });

  test('returns null when a post_visit_closeout revision already exists (idempotent)', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: INBOUND }), chain({ first: null })],
      message_drafts: [chain({ first: PRIOR_DRAFT }), chain({ first: { id: 'draft-rev-1' } })],
    });
    const res = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
    });
    expect(res).toBeNull();
  });
});

describe('draftPostVisitRevisionIfEligible', () => {
  test('returns live_drafting_off with ZERO DB queries when live drafting gates are off ($0 cost)', async () => {
    const dbh = jest.fn();
    const draftFn = jest.fn();
    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-1',
      completedAt: new Date('2026-11-27T16:30:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { isEnabled: () => false },
      draftFn,
    });
    expect(res).toEqual({ skipped: 'live_drafting_off' });
    expect(dbh).not.toHaveBeenCalled();
    expect(draftFn).not.toHaveBeenCalled();
  });

  test('invokes drafter with draftTrigger=post_visit_closeout, supersedesDraftId, and skipAutoSend=true', async () => {
    const inbound = {
      id: 'sms-in-2',
      from_phone: '+19415550188',
      message_body: 'What did you find in the garage?',
      created_at: new Date('2026-11-27T15:00:00Z'),
    };
    const dbh = makeDb({
      sms_log: [chain({ first: inbound }), chain({ first: null })],
      message_drafts: [chain({ first: { id: 'draft-orig-2', created_at: new Date('2026-11-27T15:01:00Z') } }), chain({ first: null })],
      customers: [chain({ first: { id: 'cust-2', first_name: 'Sam', city: 'Sarasota' } })],
    });
    const draftFn = jest.fn(async () => 'draft-rev-2');

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-2',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { isEnabled: (k) => k === 'smsShadowDrafts' },
      draftFn,
    });

    expect(res).toEqual({ drafted: true, draftId: 'draft-rev-2', supersedesDraftId: 'draft-orig-2' });
    expect(draftFn).toHaveBeenCalledWith(expect.objectContaining({
      smsLogId: 'sms-in-2',
      draftTrigger: POST_VISIT_TRIGGER,
      supersedesDraftId: 'draft-orig-2',
      skipAutoSend: true,
    }));
  });

  test('treats unique-index race (23505) as already_revised without throwing', async () => {
    const inbound = {
      id: 'sms-in-3',
      from_phone: '+19415550177',
      message_body: 'All done?',
      created_at: new Date('2026-11-27T15:00:00Z'),
    };
    const dbh = makeDb({
      sms_log: [chain({ first: inbound }), chain({ first: null })],
      message_drafts: [chain({ first: { id: 'draft-orig-3', created_at: new Date('2026-11-27T15:01:00Z') } }), chain({ first: null })],
      customers: [chain({ first: { id: 'cust-3', first_name: 'Pat' } })],
    });
    const draftFn = jest.fn(async () => {
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });

    const res = await draftPostVisitRevisionIfEligible({
      customerId: 'cust-3',
      completedAt: new Date('2026-11-27T17:00:00Z'),
      visitDateET: '2026-11-27',
      dbh,
      gates: { isEnabled: () => true },
      draftFn,
    });
    expect(res).toEqual({ skipped: 'already_revised' });
  });
});

describe('findPostVisitRedraftCandidates (Mac free runner)', () => {
  test('dedupes multiple records per customer and returns eligible candidates', async () => {
    const inbound = {
      id: 'sms-in-4',
      from_phone: '+19415550166',
      message_body: 'Did you treat the shed?',
      created_at: new Date('2026-11-27T13:00:00Z'),
    };
    const dbh = makeDb({
      service_records: [chain({
        result: [
          { id: 'rec-1', customer_id: 'cust-4', created_at: new Date('2026-11-27T16:00:00Z') },
          { id: 'rec-2', customer_id: 'cust-4', created_at: new Date('2026-11-27T15:00:00Z') },
        ],
      })],
      sms_log: [chain({ first: inbound }), chain({ first: null })],
      message_drafts: [chain({ first: { id: 'draft-orig-4', created_at: new Date('2026-11-27T13:01:00Z') } }), chain({ first: null })],
    });

    const list = await findPostVisitRedraftCandidates(dbh, { visitDateET: '2026-11-27' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      customerId: 'cust-4',
      serviceRecordId: 'rec-1',
      smsLogId: 'sms-in-4',
      priorDraftId: 'draft-orig-4',
    });
  });
});

describe('shadow judge baseline isolation', () => {
  test('judgeShadowDrafts filters to inbound drafts only so revisions never corrupt baselines', async () => {
    const db = require('../models/db');
    const q = {
      leftJoin: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      whereRaw: jest.fn(() => q),
      where: jest.fn(() => q),
      select: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(async () => []),
    };
    db.mockImplementation(() => q);

    const { judgeShadowDrafts } = require('../services/sms-shadow-judge');
    const res = await judgeShadowDrafts({ batchLimit: 5 });
    expect(res.judged).toBe(0);
    expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(message_drafts.draft_trigger, 'inbound') = 'inbound'");
  });
});
