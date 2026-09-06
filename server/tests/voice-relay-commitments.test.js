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
    // The close-time call site (PR 2B factored the write into _recordCommitments, used by the owning close AND the late-segment pass).
    const recordAt = conversation.indexOf("await this._recordCommitments({ transcript: commitmentsTranscript, sessionKey: this.sessionKey || null });");
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(reconcileAt);
    const site = conversation.slice(recordAt - 1500, recordAt + 200);
    // Close-time eligibility is exercised by voice-relay-segment-close and
    // the PostgreSQL segment suite, including a silent resumed transfer.
    expect(site).toContain('let commitmentsTranscript = transcriptUpdate ? transcriptUpdate.transcription : null;'); // the scrubbed transcript the reconcile wrote… or, on a reconnected call, the persisted composed one (PR 2B)
    const helperAt = conversation.indexOf('async _recordCommitments({ transcript, sessionKey, promises = this._promises }) {');
    expect(helperAt).toBeGreaterThan(-1);
    const helper = conversation.slice(helperAt, helperAt + 1600);
    expect(helper).toContain("isEnabled('callCommitments')");
    expect(helper).toContain("const { recordRelayCommitments } = require('../call-commitments');");
    expect(helper).toContain("estimateQueued: promises.has('send_estimate') ? promises.get('send_estimate').verdict : null,");
    expect(helper).toContain("estimateExpectation: promises.get('send_estimate')?.expectation || null,");
    // The deadline runs from the moment the tool spoke the expectation, not from the close.
    expect(helper).toContain("estimatePromisedAt: promises.get('send_estimate')?.at || null,");
    // The claim nonce rides into the write so the owner is re-checked under
    // the row lock, not only by the reconcile UPDATE before it.
    expect(site).toContain('sessionKey: this.sessionKey || null });');
    // Never the raw turns: those are unscrubbed.
    expect(site).not.toContain('transcript: this._transcript');
    // Check the commitment log messages themselves. Counting unrelated
    // recovery logs makes a behavior-preserving PR split fail this privacy test.
    const commitmentLogs = helper.split('\n').filter((line) => line.includes('logger.'));
    expect(commitmentLogs).toHaveLength(3);
    for (const line of commitmentLogs) expect(line).toContain('maskSid(this.callSid)');
  });

  test('the promises are recorded even when the voice-message sync rejects: the sync has its own catch ahead of the commitments block (codex #3725 r18 P2)', () => {
    const syncAt = conversation.indexOf('await syncVoiceMessageForCall(this.callSid);');
    const commitmentsAt = conversation.indexOf("await this._recordCommitments({ transcript: commitmentsTranscript, sessionKey: this.sessionKey || null });");
    expect(syncAt).toBeGreaterThan(-1);
    expect(commitmentsAt).toBeGreaterThan(syncAt);
    const between = conversation.slice(syncAt, commitmentsAt);
    expect(between).toMatch(/catch \(syncErr\)/);
  });

  test('a superseded socket never records promises under its OWN key (its close-time writes are skipped wholesale; PR 2B\'s late-segment pass runs under the row\'s CURRENT owner)', () => {
    const guardAt = conversation.indexOf('if (supersededAtClose) {');
    const closeBody = conversation.slice(guardAt, conversation.indexOf('await this._runCaptureFloor(reason);', guardAt));
    expect(closeBody).toMatch(/return;\s*}/);
    const recordAt = conversation.indexOf("await this._recordCommitments({ transcript: commitmentsTranscript, sessionKey: this.sessionKey || null });");
    expect(guardAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(guardAt);
    expect(conversation).toContain("sessionKey: owner || this.sessionKey, promises });"); // the ROW's latest promises, never the superseded socket's map
  });
});
