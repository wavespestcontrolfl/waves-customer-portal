'use strict';

const exam = require('../config/sms-gratitude-exam.json');
const { evaluateGratitudeContext } = require('../services/sms-gratitude');

function memoryDb() {
  const rows = [];
  const profile = { id: 'synthetic-profile', version: 'synthetic-profile-v1', profile_text: 'Use concise, warm replies.' };
  let sequence = 0;
  const dbi = (table) => {
    if (table === 'voice_profiles') {
      const query = {
        where() { return query; },
        orderBy() { return query; },
        first() { return Promise.resolve(profile); },
      };
      return query;
    }
    if (table !== 'agent_decisions') throw new Error(`unexpected table ${table}`);
    let filters = {};
    let requiredState = null;
    let order = null;
    let pendingInsert = null;
    const matching = () => rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)
      && (!requiredState || snapshot(row)?.state === requiredState));
    const query = {
      where(values) { filters = { ...filters, ...values }; return query; },
      whereRaw(sql) {
        if (sql === "input_snapshot->>'state' = 'running'") requiredState = 'running';
        else throw new Error(`unexpected whereRaw ${sql}`);
        return query;
      },
      orderBy(column, direction) { order = { column, direction }; return query; },
      first() {
        const found = matching().slice();
        if (order) found.sort((a, b) => {
          const result = String(a[order.column]).localeCompare(String(b[order.column]));
          return order.direction === 'desc' ? -result : result;
        });
        return Promise.resolve(found[0]);
      },
      insert(values) { pendingInsert = values; return query; },
      returning() {
        sequence += 1;
        const row = {
          ...pendingInsert,
          id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, sequence)).toISOString(),
        };
        rows.push(row);
        return Promise.resolve([row]);
      },
      update(values) {
        const found = matching();
        for (const row of found) Object.assign(row, values);
        return Promise.resolve(found.length);
      },
    };
    return query;
  };
  dbi.fn = { now: () => new Date('2030-01-01T01:00:00.000Z') };
  dbi.raw = jest.fn(async () => ({ rows: [] }));
  dbi.transaction = jest.fn(async callback => callback(dbi));
  return { dbi, rows, profile };
}

function snapshot(row) {
  return typeof row.input_snapshot === 'string' ? JSON.parse(row.input_snapshot) : row.input_snapshot;
}

function setSnapshot(row, value) {
  row.input_snapshot = JSON.stringify(value);
}

function loadQualification({ dbi, verifyEnabled = true, lockOutcome = null, lockError = null } = {}) {
  jest.resetModules();
  const previousVerify = process.env.SHADOW_DRAFT_VERIFY;
  const previousRevisions = process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS;
  process.env.SHADOW_DRAFT_VERIFY = verifyEnabled ? 'true' : 'false';
  process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS = '2';
  const dispatchWithFallback = jest.fn(async (policy, payload) => {
    expect(snapshot(dbi.rows.at(-1)).state).toBe('running');
    const encoded = payload.text.match(/APPROVED GRATITUDE REPLY: ("(?:[^"\\]|\\.)*")/);
    const approved = encoded ? JSON.parse(encoded[1]) : '';
    return {
      ok: true,
      model: policy.primary.model,
      text: JSON.stringify({
        reply: approved || 'Our pleasure, Casey!',
        intended_actions: [{ type: 'none' }],
        missing_info: null,
      }),
    };
  });
  const createDeepMessage = jest.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify({ supported: true, violations: [] }) }],
  }));
  jest.doMock('../models/db', () => dbi.dbi);
  jest.doMock('../services/llm/call', () => ({ dispatchWithFallback }));
  jest.doMock('../services/llm/deep', () => ({ createDeepMessage }));
  const runExclusive = jest.fn(async (_jobName, task) => {
    if (lockError) throw new Error(lockError);
    return lockOutcome || task();
  });
  jest.doMock('../utils/cron-lock', () => ({
    runExclusive,
    wasLockSkipped: result => result?.skipped === true
      && ['lease_held', 'no_connection'].includes(result.reason),
  }));
  const Anthropic = jest.fn(() => ({ synthetic: true }));
  jest.doMock('@anthropic-ai/sdk', () => Anthropic);
  const qualification = require('../services/sms-gratitude-qualification');
  const drafter = require('../services/sms-shadow-drafter');
  const generateGroundedDraft = jest.spyOn(drafter, 'generateGroundedDraft');
  if (previousVerify === undefined) delete process.env.SHADOW_DRAFT_VERIFY;
  else process.env.SHADOW_DRAFT_VERIFY = previousVerify;
  if (previousRevisions === undefined) delete process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS;
  else process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS = previousRevisions;
  return {
    qualification,
    generateGroundedDraft,
    dispatchWithFallback,
    createDeepMessage,
    Anthropic,
    runExclusive,
    profile: dbi.profile,
  };
}

describe('sms gratitude qualification', () => {
  afterEach(() => jest.restoreAllMocks());

  test('fixed anonymous corpus covers every requested policy boundary', () => {
    expect(exam.fixtures.map(fixture => fixture.id)).toEqual([
      'positive_report', 'positive_receipt', 'positive_completed_service', 'positive_bank_ack',
      'negative_mixed_thanks', 'negative_question', 'negative_promise', 'negative_complaint',
      'negative_booking_acceptance', 'negative_media', 'negative_prior_operational',
      'negative_new_inbound', 'negative_new_outbound', 'negative_loop',
      'negative_missing_context', 'negative_pending_work',
    ]);
    for (const fixture of exam.fixtures) {
      expect(evaluateGratitudeContext(fixture.source).eligible).toBe(fixture.expectedEligible);
    }
  });

  test('creates a durable unlinked run, exercises both live legs, and qualifies exact safe copy', async () => {
    const store = memoryDb();
    const { qualification, generateGroundedDraft, createDeepMessage, Anthropic } = loadQualification({ dbi: store });

    const created = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'admin:synthetic' });
    expect(created).toMatchObject({ id: expect.any(String), state: 'running' });
    expect(store.rows[0]).toMatchObject({
      workflow: 'sms_gratitude_qualification', mode: 'shadow', status: 'shadow',
    });
    expect(store.rows[0]).not.toHaveProperty('customer_id');
    expect(store.rows[0]).not.toHaveProperty('sms_log_id');
    expect(store.rows[0]).not.toHaveProperty('entity_id');
    expect(store.rows[0]).not.toHaveProperty('suggested_message');
    expect(snapshot(store.rows[0]).pins).toMatchObject({
      policyVersion: 'gratitude_v1',
      fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      systemPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifier: { enabled: true, maxRevisions: 2, model: expect.any(String), fallbackModel: expect.any(String) },
      voiceProfileVersion: 'synthetic-profile-v1',
    });

    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: created.id });
    expect(Anthropic).toHaveBeenCalled();
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
    expect(createDeepMessage).toHaveBeenCalledTimes(exam.fixtures.length * 2);
    const completed = snapshot(store.rows[0]);
    expect(generateGroundedDraft).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ summary: expect.stringContaining('synthetic'), smsHistory: expect.any(Array) }),
      routeOverride: completed.pins.routes.anthropic,
      metricsLane: 'sealed',
      laneId: 'sealed_eval',
    }));
    expect(completed.state).toBe('complete');
    expect(completed.results).toHaveLength(exam.fixtures.length * 2);

    await expect(qualification.evaluateGratitudeQualification({
      dbi: store.dbi,
      voiceProfileVersion: 'synthetic-profile-v1',
    })).resolves.toEqual(expect.objectContaining({ eligible: true, blockers: [], qualified: true, positives: 8, negatives: 24 }));
  });

  test('atomically refuses a live duplicate and recovers a stale running row', async () => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const first = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    await expect(qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', runId: first.id });
    expect(store.dbi.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(?)', [2026092401]);

    store.rows[0].created_at = '2000-01-01T00:00:00.000Z';
    const recovered = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    expect(recovered.id).not.toBe(first.id);
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'failed', failure: 'stale_run_recovered' });
    expect(snapshot(store.rows[1])).toMatchObject({ state: 'running' });
  });

  test('recomputes result safety and requires the complete exact fixture-leg set', async () => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const { id } = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: id });
    const row = store.rows[0];
    const complete = snapshot(row);

    complete.summary = { qualified: false, positives: 0, negatives: 0 };
    for (const result of complete.results) result.policy = { eligible: false, reason: 'tampered', reply: '' };
    setSnapshot(row, complete);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: true });

    const missing = snapshot(row);
    missing.results.pop();
    setSnapshot(row, missing);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: false, reason: 'result_set_incomplete' });

    const unsafe = complete;
    unsafe.results.find(result => result.fixtureId === 'positive_report').output.parsed.actionsRawSafe = false;
    setSnapshot(row, unsafe);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: false, reason: 'positive_failed' });
  });

  test.each([
    'server/services/sms-response-policy.js',
    'server/utils/phone.js',
    'server/services/sms-suggest-mode.js',
  ])('changes to direct safety dependency %s invalidate a pass', async (relative) => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const { id } = await qualification.createGratitudeQualification({ dbi: store.dbi });
    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: id });
    const fs = require('fs');
    const path = require('path');
    const target = path.resolve(__dirname, '../..', relative);
    const read = fs.readFileSync.bind(fs);
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...args) => {
      const contents = read(filename, ...args);
      return String(filename) === target ? Buffer.concat([contents, Buffer.from('\n// changed safety behavior')]) : contents;
    });
    try {
      await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
        .resolves.toMatchObject({ qualified: false, reason: 'pins_changed' });
    } finally {
      spy.mockRestore();
    }
  });

  test('a newer failed run invalidates an older success', async () => {
    const store = memoryDb();
    const { qualification, dispatchWithFallback } = loadQualification({ dbi: store });
    const first = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: first.id });
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: true });

    const second = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'synthetic provider outage' });
    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: second.id }))
      .rejects.toThrow('gratitude_qualification_draft_failed');
    expect(snapshot(store.rows[1])).toMatchObject({ state: 'failed', results: [] });
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ eligible: false, blockers: [expect.any(String)], qualified: false, reason: 'failed' });
  });

  test.each([
    ['resolved lock skip', { lockOutcome: { skipped: true, reason: 'no_connection' } }, 'gratitude_qualification_lock_no_connection'],
    ['busy lock skip', { lockOutcome: { skipped: true, reason: 'lease_held' } }, 'gratitude_qualification_lock_lease_held'],
    ['lock exception', { lockError: 'synthetic lock failure' }, 'synthetic lock failure'],
  ])('%s marks the durable run failed', async (_label, lock, failure) => {
    const store = memoryDb();
    const { qualification, runExclusive, generateGroundedDraft } = loadQualification({ dbi: store, ...lock });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .rejects.toThrow(failure);
    expect(runExclusive).toHaveBeenCalledWith(
      'sms-gratitude-qualification', expect.any(Function), { recordHealth: false },
    );
    expect(generateGroundedDraft).not.toHaveBeenCalled();
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'failed', results: [], failure });
  });

  test('fails closed for verifier-off runs, profile mismatch, and pin drift', async () => {
    const disabledStore = memoryDb();
    const disabled = loadQualification({ dbi: disabledStore, verifyEnabled: false });
    const disabledRun = await disabled.qualification.createGratitudeQualification({ dbi: disabledStore.dbi, triggeredBy: 'test' });
    await expect(disabled.qualification.runGratitudeQualification({ dbi: disabledStore.dbi, runId: disabledRun.id }))
      .rejects.toThrow('gratitude_qualification_pins_changed');
    expect(disabled.generateGroundedDraft).not.toHaveBeenCalled();

    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi, voiceProfileVersion: 'new-profile' }))
      .resolves.toMatchObject({ qualified: false, reason: 'voice_profile_changed' });

    const changed = snapshot(store.rows[0]);
    changed.pins.promptVersion = 'stale-prompt';
    setSnapshot(store.rows[0], changed);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: false, reason: 'pins_changed' });
  });
});
