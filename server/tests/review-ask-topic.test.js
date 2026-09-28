// review-ask-topic.js: Day-0 review-ask contextual topic (GATE_REVIEW_DAY0_CONTEXT).
// Evidence sources are ONLY inbound texts since the previous completed visit
// and the completion notes for THIS visit (owner decision 2026-09-28) — no
// calls, no transcripts. The deterministic grounding check is the safety net
// on top of the model, so it gets its own coverage independent of the model
// mock's behavior.
const mockDispatch = jest.fn();
const mockGates = { reviewDay0Context: false };

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => !!mockGates[g], gates: mockGates }));
// Real redactAccessCodes (not mocked) — one test asserts actual redaction.

const db = require('../models/db');
const {
  readTopicEvidence,
  collectTopicEvidence,
  classifyTopic,
  extractReviewTopic,
  resolveReviewTopicForEnrollment,
  TOPIC_VERSION,
} = require('../services/review-ask-topic');
const OUTREACH = require('../services/review-outreach-templates');

function toComparable(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'string') {
    const t = Date.parse(x);
    if (!Number.isNaN(t)) return t;
  }
  return x;
}

// Minimal chainable query mock covering exactly what review-ask-topic.js
// issues: where(equals)/where(col, op, val), orderBy, select, first(), and a
// thenable for a plain row array.
function makeDb(tables) {
  return jest.fn((name) => {
    const table = String(name).split(/\s+as\s+/i)[0];
    const state = { equals: [], ops: [], ins: [], notIns: [], order: null };
    const builder = {
      whereIn(col, vals) { state.ins.push([col, vals]); return builder; },
      whereNotIn(col, vals) { state.notIns.push([col, vals]); return builder; },
      where(a, b, c) {
        if (a && typeof a === 'object') { Object.entries(a).forEach(([k, v]) => state.equals.push([k, v])); return builder; }
        if (arguments.length === 3) { state.ops.push([a, b, c]); return builder; }
        state.equals.push([a, b]);
        return builder;
      },
      orderBy(col, dir = 'asc') { state.order = [col, dir]; return builder; },
      select() { return builder; },
      limit() { return builder; },
      async first() { return filtered()[0] || null; },
      then(res, rej) { return Promise.resolve(filtered()).then(res, rej); },
    };
    function filtered() {
      let rows = [...(tables[table] || [])];
      rows = rows.filter((r) => state.equals.every(([k, v]) => toComparable(r[k]) === toComparable(v)));
      rows = rows.filter((r) => state.ins.every(([k, vals]) => vals.includes(r[k])));
      rows = rows.filter((r) => state.notIns.every(([k, vals]) => !vals.includes(r[k])));
      rows = rows.filter((r) => state.ops.every(([k, op, v]) => {
        const l = r[k] == null ? null : toComparable(r[k]);
        const rv = toComparable(v);
        if (l == null) return false;
        if (op === '<') return l < rv;
        if (op === '<=') return l <= rv;
        if (op === '>') return l > rv;
        if (op === '>=') return l >= rv;
        return l === rv;
      }));
      if (state.order) {
        const [col, dir] = state.order;
        rows.sort((a, b) => {
          const av = toComparable(a[col]); const bv = toComparable(b[col]);
          if (av === bv) return 0;
          const x = av > bv ? 1 : -1;
          return dir === 'desc' ? -x : x;
        });
      }
      return rows;
    }
    return builder;
  });
}

const NOW = new Date('2026-09-28T18:00:00Z');
const RECURRING_PLAN = OUTREACH.RECURRING_SEQUENCE_PLAN;

beforeEach(() => {
  mockDispatch.mockReset();
  mockGates.reviewDay0Context = false;
});

describe('collectTopicEvidence', () => {
  test('window starts at the previous completed visit when that is within 14 days', async () => {
    const prevCompletedAt = new Date(NOW.getTime() - 5 * 86400000); // 5 days back
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'prev', customer_id: 'c1', status: 'completed', completed_at: prevCompletedAt },
      ],
      service_records: [],
      sms_log: [
        // Before the previous visit — excluded even though within 14 days.
        { id: 's-old', customer_id: 'c1', direction: 'inbound', message_body: 'Still seeing roaches near the sink', created_at: new Date(prevCompletedAt.getTime() - 60000) },
        // After the previous visit, before completedAt — included.
        { id: 's-new', customer_id: 'c1', direction: 'inbound', message_body: 'The roaches by the sink are still there', created_at: new Date(prevCompletedAt.getTime() + 60000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', serviceRecordId: null, completedAt: NOW });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-new']);
  });

  test('window is capped at 14 days even with an older previous visit', async () => {
    const prevCompletedAt = new Date(NOW.getTime() - 30 * 86400000); // 30 days back
    const floor = new Date(NOW.getTime() - 14 * 86400000);
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'prev', customer_id: 'c1', status: 'completed', completed_at: prevCompletedAt },
      ],
      service_records: [],
      sms_log: [
        // 20 days back — after the previous visit, but outside the 14-day cap.
        { id: 's-too-old', customer_id: 'c1', direction: 'inbound', message_body: 'Ants keep coming back inside', created_at: new Date(NOW.getTime() - 20 * 86400000) },
        // 10 days back — inside the cap.
        { id: 's-inside', customer_id: 'c1', direction: 'inbound', message_body: 'Ants are still coming back inside', created_at: new Date(NOW.getTime() - 10 * 86400000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', completedAt: NOW });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-inside']);
    expect(floor.getTime()).toBeLessThan(new Date(NOW.getTime() - 10 * 86400000).getTime() + 1);
  });

  test('anchors on the visit itself: a live enrollment (after markComplete) still reads pre-visit texts, and a grouped sibling at the same stop is not the previous visit', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'ss-prev', customer_id: 'c1', status: 'completed', completed_at: new Date(NOW.getTime() - 10 * 86400000) },
        { id: 'ss-sibling', customer_id: 'c1', status: 'completed', visit_id: 'v-stop', completed_at: new Date(NOW.getTime() - 30 * 60000) },
        // markComplete stamped THIS visit two minutes before enrollment ran.
        { id: 'ss-now', customer_id: 'c1', status: 'completed', visit_id: 'v-stop', completed_at: new Date(NOW.getTime() - 2 * 60000) },
      ],
      service_records: [],
      sms_log: [
        { id: 's-pre', customer_id: 'c1', direction: 'inbound', message_body: 'Can you check for roof rats on the porch?', created_at: new Date(NOW.getTime() - 86400000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', scheduledServiceId: 'ss-now', completedAt: NOW });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-pre']);
  });

  test('an independent visit earlier the same day bounds the window — its concern is not the later visit\'s topic', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'ss-prev', customer_id: 'c1', status: 'completed', completed_at: new Date(NOW.getTime() - 20 * 86400000) },
        { id: 'ss-morning', customer_id: 'c1', status: 'completed', completed_at: new Date(NOW.getTime() - 4 * 3600000) },
        { id: 'ss-now', customer_id: 'c1', status: 'completed', completed_at: NOW },
      ],
      service_records: [],
      sms_log: [
        { id: 's-before-morning', customer_id: 'c1', direction: 'inbound', message_body: 'Ants all over the kitchen again', created_at: new Date(NOW.getTime() - 86400000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', scheduledServiceId: 'ss-now' });
    expect(evidence.texts).toEqual([]);
  });

  test('the window ends at the visit\'s real start — a text after arrival (a closeout submitted hours later) is not a pre-visit topic', async () => {
    const arrivedAt = new Date(NOW.getTime() - 8 * 3600000);
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'ss-late', customer_id: 'c1', status: 'completed', arrived_at: arrivedAt, completed_at: NOW },
      ],
      service_records: [],
      sms_log: [
        { id: 's-before', customer_id: 'c1', direction: 'inbound', message_body: 'Wasps under the back eave again', created_at: new Date(arrivedAt.getTime() - 3600000) },
        { id: 's-after-visit', customer_id: 'c1', direction: 'inbound', message_body: 'Still seeing ants in the kitchen after this morning', created_at: new Date(arrivedAt.getTime() + 3 * 3600000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', scheduledServiceId: 'ss-late' });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-before']);
  });

  test('a grouped visit reads the concern from every member\'s completion, not just the one enrollment names', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'ss-pest', customer_id: 'c1', status: 'completed', visit_id: 'v-1', completed_at: NOW },
        { id: 'ss-lawn', customer_id: 'c1', status: 'completed', visit_id: 'v-1', completed_at: NOW },
      ],
      service_records: [
        { id: 'sr-pest', scheduled_service_id: 'ss-pest', structured_notes: { customerConcernText: '' } },
        { id: 'sr-lawn', scheduled_service_id: 'ss-lawn', structured_notes: { customerConcernText: 'brown patch by the driveway' } },
      ],
      sms_log: [],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', serviceRecordId: 'sr-pest', scheduledServiceId: 'ss-pest' });
    expect(evidence.completion.concernText).toBe('brown patch by the driveway');
  });

  test('texts after the visit\'s own completion are never evidence (paid-invoice enrollment days later, visit found through its service record)', async () => {
    const visitDoneAt = new Date(NOW.getTime() - 3 * 86400000);
    db.mockImplementation(makeDb({
      scheduled_services: [
        { id: 'ss-paid', customer_id: 'c1', status: 'completed', completed_at: visitDoneAt },
      ],
      service_records: [{ id: 'sr-paid', scheduled_service_id: 'ss-paid', structured_notes: null }],
      sms_log: [
        { id: 's-before', customer_id: 'c1', direction: 'inbound', message_body: 'Wasps under the back eave again', created_at: new Date(visitDoneAt.getTime() - 86400000) },
        { id: 's-after', customer_id: 'c1', direction: 'inbound', message_body: 'The ants are back in the kitchen', created_at: new Date(NOW.getTime() - 86400000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', serviceRecordId: 'sr-paid' });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-before']);
  });

  test('with no visit completion and no fallback instant, no texts are read', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [],
      sms_log: [
        { id: 's-any', customer_id: 'c1', direction: 'inbound', message_body: 'The ants are back in the kitchen', created_at: new Date(NOW.getTime() - 86400000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1' });
    expect(evidence.texts).toEqual([]);
  });

  test('excludes reactions and bodies under 12 characters', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [],
      sms_log: [
        { id: 's-reaction', customer_id: 'c1', direction: 'inbound', message_body: 'Liked "Your tech is on the way"', created_at: new Date(NOW.getTime() - 60000) },
        { id: 's-short', customer_id: 'c1', direction: 'inbound', message_body: 'ok thanks', created_at: new Date(NOW.getTime() - 50000) },
        { id: 's-kept', customer_id: 'c1', direction: 'inbound', message_body: 'The spiders in the garage are still bad', created_at: new Date(NOW.getTime() - 40000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', completedAt: NOW });
    expect(evidence.texts.map((t) => t.id)).toEqual(['s-kept']);
  });

  test('redacts access codes in text bodies', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [],
      sms_log: [
        { id: 's-code', customer_id: 'c1', direction: 'inbound', message_body: 'Gate code is 4821 and the ants are still bad out back', created_at: new Date(NOW.getTime() - 60000) },
      ],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', completedAt: NOW });
    expect(evidence.texts).toHaveLength(1);
    expect(evidence.texts[0].body).not.toContain('4821');
    expect(evidence.texts[0].body).toContain('[redacted]');
  });

  test('reads ONLY customerConcernText from structured_notes, defensively parsed — the technician\'s own findings are never a source', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [
        { id: 'sr-1', structured_notes: JSON.stringify({ customerConcernText: 'ants in the kitchen', observations: ['found ant trail under sink'], customerRecap: 'treated the kitchen', areasTreated: ['kitchen'] }) },
      ],
      sms_log: [],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', serviceRecordId: 'sr-1', completedAt: NOW });
    expect(evidence.completion).toEqual({ concernText: 'ants in the kitchen' });
  });

  test('redacts access codes in the completion concern text too', async () => {
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [
        { id: 'sr-code', structured_notes: { customerConcernText: 'Gate code is 4821, ants by the pool cage' } },
      ],
      sms_log: [],
    }));

    const evidence = await collectTopicEvidence({ customerId: 'c1', serviceRecordId: 'sr-code', completedAt: NOW });
    expect(evidence.completion.concernText).not.toContain('4821');
    expect(evidence.completion.concernText).toContain('[redacted]');
  });

  test('never throws — a lookup failure returns fully empty evidence (readTopicEvidence, the replay\'s variant, throws it instead)', async () => {
    db.mockImplementation(() => { throw new Error('pool exhausted'); });
    const evidence = await collectTopicEvidence({ customerId: 'c1', completedAt: NOW });
    expect(evidence).toEqual({ completion: { concernText: null }, texts: [] });
    await expect(readTopicEvidence({ customerId: 'c1', completedAt: NOW })).rejects.toThrow('pool exhausted');
  });
});

describe('extractReviewTopic', () => {
  test('empty evidence never calls the model and returns null', async () => {
    const result = await extractReviewTopic({ completion: { concernText: null }, texts: [] });
    expect(result).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a topic grounded only in the technician\'s observations is impossible — that key is never read as evidence, so no model call happens', async () => {
    // Simulates a caller (or a stale shape) that still carries `observations`
    // on the completion object — hasEvidenceToClassify only ever looks at
    // concernText, so this must never trigger a model call.
    const evidence = { completion: { concernText: null, observations: ['ghost ants, widow spiders'] }, texts: [] };
    const result = await extractReviewTopic(evidence);
    expect(result).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a logistics classification returns null', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: '', kind: 'logistics', source: 'sms', evidence_id: 's-1', confidence: 0.9 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'Is the tech still coming today?' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('an ungrounded topic (tokens not present in the cited evidence) is rejected', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'termite swarm activity', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.9 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'The ants in the kitchen are still bad' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('a topic of only short words ("air wig") is grounded word for word — the production replay miss', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'air wig', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.92 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'We should be around Had an air wig in the bathroom last week' }] };
    expect(await extractReviewTopic(evidence)).toMatchObject({ topic: 'air wig', kind: 'service_concern' });
  });

  test('a short-word topic never grounds on a longer word that merely contains it ("rat" in "rather")', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'rat', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.9 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: "I'd rather move the visit to Friday" }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('an invented short pest never rides along with grounded longer words ("rat noise in attic")', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'rat noise in attic', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.9 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'There is a noise in the attic at night' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('a topic longer than six words is rejected even when every word is grounded', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants all over the kitchen counter again', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.95 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'There are ants all over the kitchen counter again' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('a grounded service_concern from an sms citation is stored with the version', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants in kitchen', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.85 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'The ants in the kitchen are still bad' }] };
    const result = await extractReviewTopic(evidence, { firstName: 'Pat' });
    expect(result).toEqual({
      topic: 'ants in kitchen',
      kind: 'service_concern',
      source: 'sms',
      evidenceId: 's-1',
      confidence: 0.85,
      version: TOPIC_VERSION,
    });
  });

  test('a grounded question from completion notes (customerConcernText) is stored', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'wasp nest treatment', kind: 'question', source: 'completion', evidence_id: 'completion', confidence: 0.85 },
    });
    const evidence = { completion: { concernText: 'asked about the wasp nest treatment' }, texts: [] };
    const result = await extractReviewTopic(evidence);
    expect(result).toMatchObject({ topic: 'wasp nest treatment', kind: 'question', source: 'completion', evidenceId: 'completion' });
  });

  test('confidence below 0.8 is rejected even when grounded', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants in kitchen', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.4 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'The ants in the kitchen are still bad' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('confidence just under the 0.8 floor (0.79) is rejected even when grounded', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants in kitchen', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.79 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'The ants in the kitchen are still bad' }] };
    expect(await extractReviewTopic(evidence)).toBeNull();
  });

  test('confidence exactly at the 0.8 floor is accepted when grounded', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants in kitchen', kind: 'service_concern', source: 'sms', evidence_id: 's-1', confidence: 0.8 },
    });
    const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'The ants in the kitchen are still bad' }] };
    expect(await extractReviewTopic(evidence)).toMatchObject({ topic: 'ants in kitchen' });
  });

  test('a model throw or provider failure never throws — returns null', async () => {
    mockDispatch.mockRejectedValue(new Error('provider timeout'));
    const evidence = { completion: { concernText: 'ants in the kitchen' }, texts: [] };
    await expect(extractReviewTopic(evidence)).resolves.toBeNull();

    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    await expect(extractReviewTopic(evidence)).resolves.toBeNull();
  });
});

describe('classifyTopic (the replay\'s raw outcome)', () => {
  const evidence = { completion: { concernText: null }, texts: [{ id: 's-1', at: NOW.toISOString(), body: 'Is the tech still coming today?' }] };

  test('keeps the model\'s own kind when the topic is refused, so the replay can count logistics/praise/none', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { topic: '', kind: 'logistics', source: 'sms', evidence_id: 's-1', confidence: 0.9 } });
    await expect(classifyTopic(evidence)).resolves.toMatchObject({ status: 'classified', raw: { kind: 'logistics' }, topic: null });
  });

  test('a provider failure is "failed", never a quiet no-topic, and a throw propagates', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    await expect(classifyTopic(evidence)).resolves.toMatchObject({ status: 'failed', reason: 'all_providers_failed', topic: null });
    mockDispatch.mockRejectedValue(new Error('provider timeout'));
    await expect(classifyTopic(evidence)).rejects.toThrow('provider timeout');
  });

  test('empty evidence is "no_evidence" with no model call', async () => {
    await expect(classifyTopic({ completion: { concernText: null }, texts: [] })).resolves.toMatchObject({ status: 'no_evidence' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('resolveReviewTopicForEnrollment', () => {
  test('gate off resolves null with no db or model calls', async () => {
    mockGates.reviewDay0Context = false;
    db.mockImplementation(() => { throw new Error('must not read the db'); });
    const result = await resolveReviewTopicForEnrollment({ customerId: 'c1', completedAt: NOW, plan: RECURRING_PLAN });
    expect(result).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a non-recurring plan resolves null even with the gate on', async () => {
    mockGates.reviewDay0Context = true;
    db.mockImplementation(() => { throw new Error('must not read the db'); });
    const result = await resolveReviewTopicForEnrollment({ customerId: 'c1', completedAt: NOW, plan: OUTREACH.DEFAULT_SEQUENCE_PLAN });
    expect(result).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('gate on + recurring plan collects evidence and stores a grounded topic', async () => {
    mockGates.reviewDay0Context = true;
    db.mockImplementation(makeDb({
      scheduled_services: [],
      service_records: [{ id: 'sr-1', structured_notes: { customerConcernText: 'ants in the kitchen', observations: [], customerRecap: null } }],
      sms_log: [],
    }));
    mockDispatch.mockResolvedValue({
      ok: true,
      json: { topic: 'ants in kitchen', kind: 'service_concern', source: 'completion', evidence_id: 'completion', confidence: 0.9 },
    });
    const result = await resolveReviewTopicForEnrollment({ customerId: 'c1', serviceRecordId: 'sr-1', completedAt: NOW, plan: RECURRING_PLAN });
    expect(result).toMatchObject({ topic: 'ants in kitchen', kind: 'service_concern', source: 'completion' });
  });

  test('never throws — an evidence-collection error still resolves null', async () => {
    mockGates.reviewDay0Context = true;
    db.mockImplementation(() => { throw new Error('pool exhausted'); });
    await expect(resolveReviewTopicForEnrollment({ customerId: 'c1', completedAt: NOW, plan: RECURRING_PLAN })).resolves.toBeNull();
  });
});
