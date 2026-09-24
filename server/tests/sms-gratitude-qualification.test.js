'use strict';

const exam = require('../config/sms-gratitude-exam.json');

function memoryDb() {
  const rows = [];
  const hooks = { beforeUpdate: null };
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
    let executionTokenCondition = null;
    let expectedExecutionToken = null;
    let order = null;
    let pendingInsert = null;
    const matching = () => rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)
      && (!requiredState || snapshot(row)?.state === requiredState)
      && (executionTokenCondition !== 'absent' || snapshot(row)?.executionToken == null)
      && (executionTokenCondition !== 'equal' || snapshot(row)?.executionToken === expectedExecutionToken)
      && (executionTokenCondition !== 'absent_or_equal'
        || snapshot(row)?.executionToken == null || snapshot(row)?.executionToken === expectedExecutionToken));
    const query = {
      where(values) { filters = { ...filters, ...values }; return query; },
      whereRaw(sql, bindings = []) {
        if (sql === "input_snapshot->>'state' = 'running'") requiredState = 'running';
        else if (sql === "input_snapshot->>'executionToken' IS NULL") executionTokenCondition = 'absent';
        else if (sql === "input_snapshot->>'executionToken' = ?") {
          executionTokenCondition = 'equal';
          [expectedExecutionToken] = bindings;
        } else if (sql === "(input_snapshot->>'executionToken' IS NULL OR input_snapshot->>'executionToken' = ?)") {
          executionTokenCondition = 'absent_or_equal';
          [expectedExecutionToken] = bindings;
        }
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
        if (hooks.beforeUpdate) hooks.beforeUpdate({ rows, values });
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
  return { dbi, rows, profile, hooks };
}

function snapshot(row) {
  return typeof row.input_snapshot === 'string' ? JSON.parse(row.input_snapshot) : row.input_snapshot;
}

function setSnapshot(row, value) {
  row.input_snapshot = JSON.stringify(value);
}

function loadQualification({ dbi, verifyEnabled = true, lockOutcome = null, lockError = null,
  runExclusiveImpl = null, mutateDraft = null, beforeDispatch = null } = {}) {
  jest.resetModules();
  const previousVerify = process.env.SHADOW_DRAFT_VERIFY;
  const previousRevisions = process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS;
  process.env.SHADOW_DRAFT_VERIFY = verifyEnabled ? 'true' : 'false';
  process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS = '2';
  let draftIndex = 0;
  const dispatchWithFallback = jest.fn(async (policy, payload) => {
    if (beforeDispatch) await beforeDispatch();
    expect(snapshot(dbi.rows.at(-1)).state).toBe('running');
    const encoded = payload.text.match(/APPROVED GRATITUDE REPLY: ("(?:[^"\\]|\\.)*")/);
    const approved = encoded ? JSON.parse(encoded[1]) : '';
    const fixture = exam.fixtures[Math.floor((draftIndex % (exam.fixtures.length * 2)) / 2)];
    draftIndex += 1;
    const output = {
      reply: fixture.expectedEligible ? approved : '',
      intended_actions: [{ type: 'none' }],
      missing_info: null,
    };
    return {
      ok: true,
      model: policy.primary.model,
      text: JSON.stringify(mutateDraft ? mutateDraft({ fixture, output }) : output),
    };
  });
  const createDeepMessage = jest.fn(async () => ({
    model: require('../config/models').DEEP,
    content: [{ type: 'text', text: JSON.stringify({ supported: true, violations: [] }) }],
  }));
  jest.doMock('../models/db', () => dbi.dbi);
  jest.doMock('../services/llm/call', () => ({ dispatchWithFallback }));
  jest.doMock('../services/llm/deep', () => ({ createDeepMessage }));
  const defaultRunExclusive = async (_jobName, task) => {
    if (lockError) throw new Error(lockError);
    return lockOutcome || task();
  };
  const runExclusive = jest.fn(runExclusiveImpl || defaultRunExclusive);
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
    drafter,
    profile: dbi.profile,
  };
}

describe('sms gratitude qualification', () => {
  afterEach(() => jest.restoreAllMocks());

  test('creates a durable unlinked run, exercises both live legs, and qualifies exact safe copy', async () => {
    const store = memoryDb();
    const { qualification, generateGroundedDraft, createDeepMessage, Anthropic } = loadQualification({ dbi: store });
    const verifierFallbackModel = require('../config/models').TEXT_POLICIES.deepAnalysis.fallback.model;

    const created = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'admin:synthetic' });
    expect(created).toMatchObject({ id: expect.any(String), state: 'running' });
    expect(store.rows[0]).toMatchObject({
      workflow: 'sms_gratitude_qualification', mode: 'shadow', status: 'initiated',
    });
    expect(store.rows[0]).not.toHaveProperty('customer_id');
    expect(store.rows[0]).not.toHaveProperty('sms_log_id');
    expect(store.rows[0]).not.toHaveProperty('entity_id');
    expect(store.rows[0]).not.toHaveProperty('suggested_message');
    expect(snapshot(store.rows[0]).pins).toMatchObject({
      policyVersion: 'gratitude_v1',
      fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceFiles: expect.arrayContaining(['server/services/sms-gratitude-grading.js']),
      systemPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifier: { enabled: true, maxRevisions: 2, model: expect.any(String), fallbackModel: verifierFallbackModel },
      voiceProfileVersion: 'synthetic-profile-v1',
    });

    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: created.id });
    expect(Anthropic).toHaveBeenCalled();
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
    expect(createDeepMessage).toHaveBeenCalledTimes(exam.fixtures.filter(f => f.expectedEligible).length * 2);
    const completed = snapshot(store.rows[0]);
    expect(generateGroundedDraft).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ summary: expect.stringContaining('synthetic'), smsHistory: expect.any(Array) }),
      intent: expect.objectContaining({ approvedReply: 'Our pleasure, Casey!' }),
      routeOverride: completed.pins.routes.anthropic,
      metricsLane: 'sealed',
      laneId: 'sealed_eval',
    }));
    expect(completed.state).toBe('complete');
    expect(completed.results).toHaveLength(exam.fixtures.length * 2);
    const negativeResults = completed.results.filter(result => result.fixtureId.startsWith('negative_'));
    expect(negativeResults).toHaveLength(24);
    expect(negativeResults.every(result => result.output.parsed.reply === ''
      && result.output.passes === 1 && result.output.converged === true
      && result.output.verifierModels.length === 0)).toBe(true);
    expect(completed.results.filter(result => result.fixtureId.startsWith('positive_'))
      .every(result => result.output.verifierModels.length === 1
        && result.output.verifierModels[0] === completed.pins.verifier.model)).toBe(true);
    expect(completed.summary).toMatchObject({ qualified: true, positives: 8, negatives: 24 });
    expect(store.rows[0]).toMatchObject({ status: 'shadow', correction_note: null });

    await expect(qualification.evaluateGratitudeQualification({
      dbi: store.dbi,
      voiceProfileVersion: 'synthetic-profile-v1',
    })).resolves.toEqual(expect.objectContaining({ eligible: true, blockers: [], qualified: true, positives: 8, negatives: 24 }));
  });

  test('pins and freezes only a voice profile that was applied to the system prompt', async () => {
    const store = memoryDb();
    const { qualification, drafter } = loadQualification({ dbi: store });
    jest.spyOn(drafter, 'buildSystemPromptWithProfile').mockReturnValue({
      system: 'Synthetic base system prompt without a voice profile.',
      applied: false,
    });

    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    expect(run.pins).toMatchObject({
      voiceProfileVersion: null,
      voiceProfileTextSha256: null,
    });
    expect(snapshot(store.rows[0]).frozenVoiceProfile).toBeNull();

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .resolves.toMatchObject({ state: 'complete', qualified: true });
    expect(snapshot(store.rows[0]).results.every(result => result.output.voiceProfileVersion === null)).toBe(true);
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
    expect(store.rows[0]).toMatchObject({ status: 'failed', correction_note: 'stale_run_recovered' });
    expect(snapshot(store.rows[1])).toMatchObject({ state: 'running' });
    expect(store.rows[1].status).toBe('initiated');
  });

  test('stale recovery loses safely when the owner completes after the stale read', async () => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const first = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    store.rows[0].created_at = '2000-01-01T00:00:00.000Z';
    store.hooks.beforeUpdate = () => {
      store.hooks.beforeUpdate = null;
      setSnapshot(store.rows[0], {
        ...snapshot(store.rows[0]), state: 'complete', results: [{ preserved: true }],
      });
      Object.assign(store.rows[0], { status: 'shadow', correction_note: null });
    };

    await expect(qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', runId: first.id, state: 'complete' });
    expect(store.rows).toHaveLength(1);
    expect(snapshot(store.rows[0])).toMatchObject({
      state: 'complete', results: [{ preserved: true }],
    });
    expect(store.rows[0]).toMatchObject({ status: 'shadow', correction_note: null });
  });

  test('regrades the persisted result instead of trusting its stored summary', async () => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store });
    const { id } = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    await qualification.runGratitudeQualification({ dbi: store.dbi, runId: id });
    const row = store.rows[0];
    const complete = snapshot(row);

    complete.summary = { qualified: false, positives: 0, negatives: 0 };
    setSnapshot(row, complete);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: true });

    const unsafe = structuredClone(complete);
    unsafe.results.find(result => result.fixtureId === 'positive_report').output.parsed.actionsRawSafe = false;
    setSnapshot(row, unsafe);
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ qualified: false, reason: 'positive_failed' });
  });

  test.each([
    ['nonempty negative', ({ fixture, output }) => fixture.id === 'negative_question'
      ? { ...output, reply: 'Our pleasure, Casey!' } : output],
    ['unsafe negative action', ({ fixture, output }) => fixture.id === 'negative_question'
      ? { ...output, intended_actions: [{ type: 'escalate' }] } : output],
  ])('%s completes the exam but records a failed qualification lifecycle', async (_label, mutateDraft) => {
    const store = memoryDb();
    const { qualification } = loadQualification({ dbi: store, mutateDraft });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .resolves.toMatchObject({ state: 'complete', qualified: false, reason: 'false_positive' });
    expect(snapshot(store.rows[0])).toMatchObject({
      state: 'complete', summary: { qualified: false, reason: 'false_positive' },
    });
    expect(store.rows[0]).toMatchObject({ status: 'qualification_failed', correction_note: 'false_positive' });
  });

  test.each([
    'server/services/sms-gratitude-grading.js',
    'server/services/sms-response-policy.js',
    'server/utils/phone.js',
    'server/services/sms-suggest-mode.js',
    'server/services/messaging/send-customer-message.js',
    'server/services/messaging/providers/twilio-sms.js',
    'server/services/twilio.js',
    'server/services/messaging/push-channel-routing.js',
    'server/services/messaging/send-manual-customer-sms.js',
    'server/services/messaging/review-ask-reservation.js',
    'server/routes/admin-drafts.js',
    'server/routes/tech-line.js',
    'server/services/intelligence-bar/comms-tools.js',
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
    expect(store.rows[1]).toMatchObject({ status: 'failed', correction_note: 'gratitude_qualification_draft_failed' });
    await expect(qualification.evaluateGratitudeQualification({ dbi: store.dbi }))
      .resolves.toMatchObject({ eligible: false, blockers: [expect.any(String)], qualified: false, reason: 'failed' });
  });

  test.each([
    ['resolved lock skip', { lockOutcome: { skipped: true, reason: 'no_connection' } }, 'gratitude_qualification_lock_no_connection'],
    ['lock exception', { lockError: 'synthetic lock failure' }, 'synthetic lock failure'],
  ])('%s marks the durable run failed', async (_label, lock, failure) => {
    const store = memoryDb();
    const { qualification, runExclusive, generateGroundedDraft } = loadQualification({ dbi: store, ...lock });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .rejects.toThrow(failure);
    expect(runExclusive).toHaveBeenCalledWith(
      `sms-gratitude-qualification:${run.id}`, expect.any(Function), { recordHealth: false },
    );
    expect(generateGroundedDraft).not.toHaveBeenCalled();
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'failed', results: [], failure });
    expect(store.rows[0]).toMatchObject({ status: 'failed', correction_note: failure });
  });

  test('a duplicate runner covered by the active lease leaves the owner authoritative', async () => {
    const store = memoryDb();
    let releaseOwner;
    let ownerHasLease;
    let held = false;
    const ownerPaused = new Promise(resolve => { ownerHasLease = resolve; });
    const ownerRelease = new Promise(resolve => { releaseOwner = resolve; });
    const runExclusiveImpl = async (_jobName, task) => {
      if (held) return { skipped: true, reason: 'lease_held' };
      held = true;
      ownerHasLease();
      await ownerRelease;
      try { return await task(); } finally { held = false; }
    };
    const { qualification, runExclusive, generateGroundedDraft } = loadQualification({
      dbi: store, runExclusiveImpl,
    });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    const owner = qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await ownerPaused;
    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .resolves.toEqual({ skipped: true, reason: 'lease_held' });
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'running', results: [] });
    expect(store.rows[0].status).toBe('initiated');
    expect(generateGroundedDraft).not.toHaveBeenCalled();

    releaseOwner();
    await expect(owner).resolves.toMatchObject({ id: run.id, state: 'complete' });
    expect(runExclusive).toHaveBeenCalledTimes(2);
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'complete' });
    expect(store.rows[0].status).toBe('shadow');
  });

  test.each([
    ['no connection', async () => ({ skipped: true, reason: 'no_connection' }), 'gratitude_qualification_lock_no_connection'],
    ['lock exception', async () => { throw new Error('synthetic duplicate lock failure'); }, 'synthetic duplicate lock failure'],
  ])('a duplicate %s cannot fail an owner that claimed execution', async (_label, duplicateLock, failure) => {
    const store = memoryDb();
    let releaseDraft;
    let announceDraft;
    let draftPaused = false;
    let invocation = 0;
    const draftStarted = new Promise(resolve => { announceDraft = resolve; });
    const draftRelease = new Promise(resolve => { releaseDraft = resolve; });
    const runExclusiveImpl = async (_jobName, task) => {
      invocation += 1;
      if (invocation > 1) return duplicateLock();
      return task();
    };
    const beforeDispatch = async () => {
      if (draftPaused) return;
      draftPaused = true;
      announceDraft();
      await draftRelease;
    };
    const { qualification, generateGroundedDraft } = loadQualification({
      dbi: store, runExclusiveImpl, beforeDispatch,
    });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    const owner = qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await draftStarted;

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .rejects.toThrow(failure);
    expect(snapshot(store.rows[0])).toMatchObject({
      state: 'running', executionToken: expect.any(String), executionStartedAt: expect.any(String),
    });
    expect(store.rows[0].status).toBe('initiated');

    releaseDraft();
    await expect(owner).resolves.toMatchObject({ id: run.id, state: 'complete', qualified: true });
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
  });

  test('an acquisition failure before the execution claim makes the owner skip model calls', async () => {
    const store = memoryDb();
    let releaseOwner;
    let announceOwner;
    let invocation = 0;
    const ownerPaused = new Promise(resolve => { announceOwner = resolve; });
    const ownerRelease = new Promise(resolve => { releaseOwner = resolve; });
    const runExclusiveImpl = async (_jobName, task) => {
      invocation += 1;
      if (invocation > 1) return { skipped: true, reason: 'no_connection' };
      announceOwner();
      await ownerRelease;
      return task();
    };
    const { qualification, generateGroundedDraft } = loadQualification({ dbi: store, runExclusiveImpl });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    const owner = qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await ownerPaused;

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .rejects.toThrow('gratitude_qualification_lock_no_connection');
    expect(snapshot(store.rows[0])).toMatchObject({
      state: 'failed', failure: 'gratitude_qualification_lock_no_connection',
    });

    releaseOwner();
    await expect(owner).resolves.toEqual({
      id: run.id, state: 'failed', skipped: true, reason: 'run_not_running',
    });
    expect(generateGroundedDraft).not.toHaveBeenCalled();
  });

  test('a callback that finds an existing execution token skips without model calls', async () => {
    const store = memoryDb();
    const { qualification, generateGroundedDraft } = loadQualification({ dbi: store });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    const marked = snapshot(store.rows[0]);
    marked.executionToken = '00000000-0000-4000-8000-999999999999';
    marked.executionStartedAt = '2030-01-01T00:00:00.000Z';
    setSnapshot(store.rows[0], marked);

    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id }))
      .resolves.toEqual({ id: run.id, state: 'running', skipped: true, reason: 'run_not_running' });
    expect(snapshot(store.rows[0])).toEqual(marked);
    expect(generateGroundedDraft).not.toHaveBeenCalled();
  });

  test('a replacement run does not inherit the stale owner lease', async () => {
    const store = memoryDb();
    let releaseStaleOwner;
    let announceStaleOwner;
    const held = new Set();
    const staleOwnerPaused = new Promise(resolve => { announceStaleOwner = resolve; });
    const staleOwnerRelease = new Promise(resolve => { releaseStaleOwner = resolve; });
    let staleJobName;
    const runExclusiveImpl = async (jobName, task) => {
      if (held.has(jobName)) return { skipped: true, reason: 'lease_held' };
      held.add(jobName);
      try {
        if (!staleJobName) {
          staleJobName = jobName;
          announceStaleOwner();
          await staleOwnerRelease;
        }
        return await task();
      } finally {
        held.delete(jobName);
      }
    };
    const { qualification, runExclusive, generateGroundedDraft } = loadQualification({
      dbi: store, runExclusiveImpl,
    });
    const stale = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    const staleOwner = qualification.runGratitudeQualification({ dbi: store.dbi, runId: stale.id });
    await staleOwnerPaused;

    store.rows[0].created_at = '2000-01-01T00:00:00.000Z';
    const replacement = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });
    await expect(qualification.runGratitudeQualification({ dbi: store.dbi, runId: replacement.id }))
      .resolves.toMatchObject({ id: replacement.id, state: 'complete', qualified: true });
    expect(runExclusive.mock.calls.map(([jobName]) => jobName)).toEqual([
      `sms-gratitude-qualification:${stale.id}`,
      `sms-gratitude-qualification:${replacement.id}`,
    ]);
    expect(snapshot(store.rows[0])).toMatchObject({ state: 'failed', failure: 'stale_run_recovered' });
    expect(snapshot(store.rows[1])).toMatchObject({ state: 'complete' });

    releaseStaleOwner();
    await expect(staleOwner).resolves.toEqual({
      id: stale.id, state: 'failed', skipped: true, reason: 'run_not_running',
    });
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
  });

  test('a queued late acquirer rereads the durable row and skips after the owner completes', async () => {
    const store = memoryDb();
    let releaseOwner;
    let announceOwner;
    let invocation = 0;
    let turn = Promise.resolve();
    const ownerPaused = new Promise(resolve => { announceOwner = resolve; });
    const ownerRelease = new Promise(resolve => { releaseOwner = resolve; });
    const runExclusiveImpl = (_jobName, task) => {
      invocation += 1;
      const current = invocation;
      const previous = turn;
      let releaseTurn;
      turn = new Promise(resolve => { releaseTurn = resolve; });
      return previous.then(async () => {
        if (current === 1) {
          announceOwner();
          await ownerRelease;
        }
        try { return await task(); } finally { releaseTurn(); }
      });
    };
    const { qualification, runExclusive, generateGroundedDraft } = loadQualification({
      dbi: store, runExclusiveImpl,
    });
    const run = await qualification.createGratitudeQualification({ dbi: store.dbi, triggeredBy: 'test' });

    const owner = qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await ownerPaused;
    const late = qualification.runGratitudeQualification({ dbi: store.dbi, runId: run.id });
    await new Promise(resolve => setImmediate(resolve));
    expect(runExclusive).toHaveBeenCalledTimes(2);
    releaseOwner();

    await expect(owner).resolves.toMatchObject({ state: 'complete', qualified: true });
    await expect(late).resolves.toEqual({
      id: run.id, state: 'complete', skipped: true, reason: 'run_not_running',
    });
    expect(generateGroundedDraft).toHaveBeenCalledTimes(exam.fixtures.length * 2);
    expect(store.rows[0].status).toBe('shadow');
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
