// Sandy's promises reach the Owed queue: the capture_lead tool tells the
// session when an estimate is really queued, and the session records
// commitments at close from the SCRUBBED transcript it just wrote — after
// the fenced reconcile, gated, never throwing into the close path.
const fs = require('fs');

const conversation = fs.readFileSync(require.resolve('../services/voice-agent/relay-conversation'), 'utf8');
const tools = fs.readFileSync(require.resolve('../services/voice-agent/relay-tools'), 'utf8');

describe('the promised-estimate watcher hands off to the Owed lane only while the gate is on; the callbacks digest never does', () => {
  test('the estimate predicate comes from commitmentsHandoffClause (empty with the gate off); the callbacks lane keeps its same-day coverage (Codex #3725 r8)', () => {
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
    const { commitmentsHandoffClause } = require('../services/promised-estimate-watcher');
    expect(commitmentsHandoffClause('send_estimate')).toBe('');
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
    jest.resetModules();
    const on = require('../services/promised-estimate-watcher').commitmentsHandoffClause('send_estimate');
    expect(on).toContain("cc.kind = 'send_estimate'");
    expect(on).toContain('NOT EXISTS');
    const promised = fs.readFileSync(require.resolve('../services/promised-estimate-watcher'), 'utf8');
    const unworked = fs.readFileSync(require.resolve('../services/unworked-comms-watcher'), 'utf8');
    expect(promised).toContain("${commitmentsHandoffClause('send_estimate')}");
    // The EOD callbacks digest pages the same evening; the watchdog only
    // rings the next morning, so callbacks are never handed off.
    expect(unworked).not.toContain('commitmentsHandoffClause');
    // No unconditional hand-off predicate survives in either query: the
    // only call_commitments sub-select in the estimate watcher is the
    // helper body itself, and the callbacks watcher has none of its own.
    expect(promised.match(/SELECT 1 FROM call_commitments/g)).toHaveLength(1);
    expect(unworked).not.toContain("SELECT 1 FROM call_commitments");
  });
});

describe('relay session → owed commitments', () => {
  test('capture_lead reports a QUEUED estimate to the session, and only then', () => {
    // Tri-state: a queued estimate is a promise, a REFUSED one is recorded as
    // such so the close never turns the refusal wording into an obligation.
    const at = tools.indexOf("if (estimateQueued !== null && typeof ctx.notePromise === 'function') ctx.notePromise('send_estimate', estimateQueued === true, { expectation: spokenExpectation });");
    expect(at).toBeGreaterThan(-1);
    // Before the copy that tells the model what it may promise.
    expect(tools.indexOf('const expectationCopy = {')).toBeGreaterThan(at);
  });

  test('the session tracks promises and records them after the reconcile UPDATE landed, from the scrubbed transcript', () => {
    expect(conversation).toContain("notePromise: (kind, verdict = true, extra = {}) => { this._promises.set(String(kind || ''), { verdict: verdict === true, expectation: extra?.expectation || null, at: new Date() }); },");
    expect(conversation).toContain('this._promises = new Map();');
    const reconcileAt = conversation.indexOf('const updated = await reconcileQuery');
    const recordAt = conversation.indexOf("const { recordRelayCommitments } = require('../call-commitments');");
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(reconcileAt);
    const site = conversation.slice(recordAt - 500, recordAt + 1000);
    expect(site).toContain('if ((updated || transferSalvaged) && transcriptUpdate?.transcription) {'); // the transfer's salvage qualifies too (PR 2A codex r2 P2)
    expect(site).toContain("isEnabled('callCommitments')");
    expect(site).toContain('let commitmentsTranscript = transcriptUpdate.transcription;'); // the scrubbed transcript the reconcile wrote…
    expect(site).toContain('transcript: commitmentsTranscript,'); // …or, on a reconnected call, the persisted composed one (PR 2B)
    expect(site).toContain("estimateQueued: this._promises.has('send_estimate') ? this._promises.get('send_estimate').verdict : null,");
    expect(site).toContain("estimateExpectation: this._promises.get('send_estimate')?.expectation || null,");
    // The deadline runs from the moment the tool spoke the expectation, not from the close.
    expect(site).toContain("estimatePromisedAt: this._promises.get('send_estimate')?.at || null,");
    // The claim nonce rides into the write so the owner is re-checked under
    // the row lock, not only by the reconcile UPDATE before it.
    expect(site).toContain('sessionKey: this.sessionKey || null,');
    // Never the raw turns: those are unscrubbed.
    expect(site).not.toContain('transcript: this._transcript');
    // Railway logs are plaintext: the three commitment log lines, the
    // message-sync failure line, and the three telemetry lines (per-turn
    // stats, relay event shape, relay_failed salvage) carry a masked CallSid.
    expect(conversation).toContain("const { maskSid } = require('../twilio-failure-alerts');");
    expect(conversation.match(/callSid=\$\{maskSid\(this\.callSid\)\}/g)).toHaveLength(17); // PR 2A stash +1; PR 2B recovery (resume proof, handoff, floor skip, segment append, late-segment sync) +9
  });

  test('the promises are recorded even when the voice-message sync rejects: the sync has its own catch ahead of the commitments block (codex #3725 r18 P2)', () => {
    const syncAt = conversation.indexOf('await syncVoiceMessageForCall(this.callSid);');
    const commitmentsAt = conversation.indexOf("require('../call-commitments')");
    expect(syncAt).toBeGreaterThan(-1);
    expect(commitmentsAt).toBeGreaterThan(syncAt);
    const between = conversation.slice(syncAt, commitmentsAt);
    expect(between).toMatch(/catch \(syncErr\)/);
  });

  test('a superseded socket never records promises (its close-time writes are skipped wholesale)', () => {
    const guardAt = conversation.indexOf('if (this.callSid && !supersededAtClose) {');
    const recordAt = conversation.indexOf("const { recordRelayCommitments } = require('../call-commitments');");
    expect(guardAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(guardAt);
  });
});
