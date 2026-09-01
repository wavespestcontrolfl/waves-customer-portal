// A blocked processing claim is not a completed run. The route maps the
// processor's { skipped, reason: 'already_processing' } result to HTTP 409 so
// no client can render it as success — on 2026-08-31 the owner's manual
// Process tap during a wedged claim got a 200 and a success toast while the
// call sat unprocessed for 18 minutes. Other skip reasons completed real work
// (e.g. a rejected transcription) and must stay 200.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const CallRecordingProcessor = require('../services/call-recording-processor');
const router = require('../routes/admin-call-recordings');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return fn(baseUrl).finally(() => new Promise((r) => server.close(r)));
}

const SID = 'CA' + '0'.repeat(32);

describe('POST /process/:callSid skip semantics', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a blocked claim returns 409 with the explanation, never a bare 200', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({
      success: false, skipped: true, reason: 'already_processing',
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}`, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('already_processing');
      expect(body.error).toMatch(/still working this call/i);
    });
  });

  test('a skip that completed real work stays 200', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({
      success: true, skipped: true, reason: 'transcription_rejected_implausible',
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe('transcription_rejected_implausible');
    });
  });

  test('a successful run stays 200 and passes through', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({ success: true, extracted: { first_name: 'Test' } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}?force=true`, { method: 'POST' });
      expect(res.status).toBe(200);
      // force implies operator: a reprocess is a human asking too.
      expect(CallRecordingProcessor.processRecording).toHaveBeenCalledWith(SID, { force: true, operator: true });
    });
  });
});

// A settled skip COMPLETED work — the bulk counters must not report it as
// nothing done, which would prompt a needless reprocess of a call that was
// correctly classified. An ownership loss is the opposite: it finished
// NOTHING and must never land in `processed`.
// The retry window differs by caller: a forced run takes over 3 quiet
// minutes after a claim stops beating, an unforced one waits 10. Telling
// every operator the long number cost about seven minutes on a hot call.
// `force` means "re-run a finished call" and carries extraction policy of its
// own; `operator` means "a human pressed the button" and selects the short
// quiet window. Conflating them made a manual FIRST run behave like a
// historical reprocess.
// A pass that loses its claim must not write through a DELEGATED module
// either: the scorer awaits a provider for minutes and then inserts a
// non-idempotent row of its own.
describe('the CSR scorer refuses to persist after ownership moves', () => {
  const source = require('fs').readFileSync(require.resolve('../services/csr/csr-coach'), 'utf8');

  test('the ownership check sits immediately before the score insert', () => {
    const insertAt = source.indexOf("db('csr_call_scores').insert(");
    expect(insertAt).toBeGreaterThan(-1);
    const preceding = source.slice(Math.max(0, insertAt - 400), insertAt);
    expect(preceding).toContain('stillOwnsClaim');
    expect(preceding).toContain("reason: 'ownership_lost'");
  });

  test('the processor hands its claim check to the scorer', () => {
    const processor = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const callAt = processor.indexOf('CSRCoach.scoreCall({');
    expect(callAt).toBeGreaterThan(-1);
    expect(processor.slice(callAt, callAt + 300)).toContain('stillOwnsClaim');
  });
});

describe('operator intent is distinct from force', () => {
  test('operator shortens the quiet window WITHOUT taking the force branch', () => {
    // The force branch omits the extraction_failed cap and backoff, so an
    // operator click routed through it could re-enter this side-effect-heavy
    // pipeline over and over.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(source).toContain('if (!opts.force) {');
    expect(source).not.toContain('if (!(opts.force || opts.operator)) {');
    // operator only picks the window inside the non-force predicate.
    expect(source).toMatch(/opts\.operator \? FORCE_CLAIM_QUIET_MINUTES : LEGACY_CLAIM_QUIET_MINUTES/);
  });

  beforeEach(() => jest.clearAllMocks());

  test('a plain operator click does not set force', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({ success: true });
    await withServer(async (base) => {
      await fetch(`${base}/admin/call-recordings/process/${SID}?operator=true`, { method: 'POST' });
    });
    expect(CallRecordingProcessor.processRecording)
      .toHaveBeenCalledWith(SID, { force: false, operator: true });
  });

  test('an unattended run is neither', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({ success: true });
    await withServer(async (base) => {
      await fetch(`${base}/admin/call-recordings/process/${SID}`, { method: 'POST' });
    });
    expect(CallRecordingProcessor.processRecording)
      .toHaveBeenCalledWith(SID, { force: false, operator: false });
  });
});

describe('the 409 names the retry window that actually applies', () => {
  beforeEach(() => jest.clearAllMocks());

  // retryAfterMinutes null = the processor sent no window at all.
  const conflictFor = (query, retryAfterMinutes = 3) => {
    CallRecordingProcessor.processRecording.mockResolvedValue({
      success: false,
      skipped: true,
      reason: 'already_processing',
      ...(retryAfterMinutes === null ? {} : { retryAfterMinutes }),
    });
    return withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}${query}`, { method: 'POST' });
      expect(res.status).toBe(409);
      return (await res.json()).error;
    });
  };

  test('a forced run is told 3 minutes', async () => {
    expect(await conflictFor('?force=true')).toMatch(/about 3 minutes/);
  });

  test('an unforced run is told 10', async () => {
    expect(await conflictFor('', 10)).toMatch(/about 10 minutes/);
  });

  test('a forced run blocked behind a NON-beating claim is told the long window', async () => {
    // A legacy row, or a pod mid-rolling-deploy, keeps the conservative
    // window whatever the caller asked for — promising 3 sent the operator
    // back into a conflict for several more minutes.
    expect(await conflictFor('?force=true', 10)).toMatch(/about 10 minutes/);
  });

  test('a body with no window falls back to the conservative one', async () => {
    expect(await conflictFor('?force=true', null)).toMatch(/about 10 minutes/);
  });
});

describe('processAllPending counters', () => {
  const { summarizeBatch } = jest.requireActual('../services/call-recording-processor')._test;

  test('a classified voicemail is processed; a blocked claim and an ownership loss are not', () => {
    const result = summarizeBatch([
      { success: true },
      { success: true, skipped: true, reason: 'voicemail' },
      { success: false, skipped: true, reason: 'already_processing' },
      { success: false, skipped: true, reason: 'terminal_write_ownership_lost' },
      { success: false, error: 'provider timeout' },
    ]);
    expect(result).toEqual({ processed: 2, skipped: 2, failed: 1, attempted: 5 });
  });

  test('an empty batch reports nothing rather than dividing by itself', () => {
    expect(summarizeBatch([])).toEqual({ processed: 0, skipped: 0, failed: 0, attempted: 0 });
  });
});

// The claim ceiling must stay ABOVE what a healthy pass can legitimately
// spend, or it reclaims a slow-but-working run out from under itself. The
// derivation mirrors the processor's own timeout map — pinned here so the two
// cannot drift apart silently.
// Fencing a write stops a stale WRITE; it does not stop a stale PASS. Between
// the transcript checkpoint and the terminal write the processor creates
// customers, mints leads, books appointments and SENDS SMS — none of which a
// token fence on a later UPDATE can take back.
describe('every side-effect boundary is gated on still owning the claim', () => {
  const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test.each([
    ['Step 3: Create or update customer', 'the customer write'],
    ['Step 4b: Create lead', 'the lead write'],
    ['Step 5: If appointment detected', 'the appointment SMS'],
    ['Step 6: Enroll in the local new_lead automation', 'the automation enrollment'],
    ['Step 7b: Generate lead synopsis', 'the synopsis and scoring writes'],
    ['VoicemailLeadSms', 'the voicemail quote-link text'],
    ['DroppedCallSms.sendDroppedCallAddressRequest', 'the dropped-call address text'],
  ])('%s is preceded by an ownership check', (stepMarker, label) => {
    const at = source.indexOf(stepMarker);
    expect(at).toBeGreaterThan(-1);
    // The gate sits immediately before the step, not somewhere upstream.
    const preceding = source.slice(Math.max(0, at - 600), at);
    expect(preceding).toContain(`abandonToPeer('${label}')`);
    expect(preceding).toContain('stillOwnsClaim()');
  });

  test('abandoning reports an ownership loss, not a failure', () => {
    const helper = source.match(/const abandonToPeer = [\s\S]*?\n    \};/)[0];
    expect(helper).toContain("reason: 'terminal_write_ownership_lost'");
    expect(helper).toContain('success: false');
    expect(helper).toContain('skipped: true');
  });
});

describe('claim ceiling is derived from the provider budgets', () => {
  const { alertCeilingMinutes, providerBudgetMs } = require('../utils/claim-ceiling');
  const { PROVIDER_FETCH_TIMEOUTS_MS } = jest.requireActual('../services/call-recording-processor')._test;

  test('the mirrored budget counts every sequential leg at the processor timeouts', () => {
    // Primary + provider fallback + contact dictation transcriptions, two
    // labeling attempts, two V1 extraction attempts PLUS the CSR scoring,
    // lead-synopsis, contact-decoder and address-recovery legs (recovery is
    // one aggregate deadline, plus the one validation it may have in flight),
    // the download and the V2 fallback chain — the worst case a HEALTHY pass
    // can reach while holding its claim.
    const expected = PROVIDER_FETCH_TIMEOUTS_MS.recording_download
      + (3 * PROVIDER_FETCH_TIMEOUTS_MS.transcription)
      + (2 * PROVIDER_FETCH_TIMEOUTS_MS.transcript_label)
      + (6 * PROVIDER_FETCH_TIMEOUTS_MS.extraction)
      + 30000
      + require('../services/llm/call').DEFAULT_FALLBACK_BUDGET_MS;
    expect(providerBudgetMs()).toBe(expected);
  });

  test('the bell sits above every budgeted provider path', () => {
    expect(alertCeilingMinutes() * 60000).toBeGreaterThan(providerBudgetMs());
  });

  test('a NULL heartbeat keeps the conservative window — a rolling deploy is not a death', () => {
    // An older pod holds a healthy claim while knowing nothing about the
    // column; reading its silence as death let the new pod steal a live
    // transcription after three minutes.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const predicate = source.match(/const reclaimableClaim = [^;]+;/s)[0];
    expect(predicate).toContain('CURRENT_BEAT');
    expect(predicate).toContain('LEGACY_CLAIM_QUIET_MINUTES');
  });

  test('a beat left by a PREVIOUS claim does not speak for this one', () => {
    // An old pod reclaiming a row it had processed before carries a stale
    // heartbeat; reading it as this claim's silence stole the live pass at
    // once. The COALESCE keeps a NULL start from making the row match
    // neither branch, which would be permanently unreclaimable.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const beat = source.match(/const CURRENT_BEAT = [^;]+;/s)[0];
    expect(beat).toContain('processing_heartbeat_at >= COALESCE(processing_started_at, processing_heartbeat_at)');
  });

  // An unbounded call is what let a pass hang while its timer kept beating,
  // which made a wedged claim unreclaimable and drove a dozen rounds of
  // trying to size a ceiling that could steal live work. This scans the
  // processor AND the modules it awaits while holding the claim — an earlier
  // version looked only at the processor and missed the CSR coach.
  // Delegated fetches count too: the pass awaits them while holding the
  // claim, and the earlier version of this scan looked only for Anthropic
  // clients — which is how the contact decoder and address recovery stayed
  // unbounded behind a test written to prevent exactly that.
  test.each([
    ['../services/contact-dictation'],
    ['../services/address-validation/recovery'],
  ])('%s bounds every outbound fetch', (modulePath) => {
    const source = require('fs').readFileSync(require.resolve(modulePath), 'utf8');
    const starts = [];
    for (let i = source.indexOf('await fetch('); i !== -1; i = source.indexOf('await fetch(', i + 1)) {
      starts.push(i);
    }
    expect(starts.length).toBeGreaterThan(0);
    starts.forEach((start, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1] : source.length;
      expect(source.slice(start, end)).toContain('AbortSignal.timeout(');
    });
  });

  test.each([
    ['../services/call-recording-processor', /timeout: PROVIDER_FETCH_TIMEOUTS_MS/],
    ['../services/csr/csr-coach', /timeout: CSR_SCORE_TIMEOUT_MS/],
  ])('%s bounds every direct Anthropic call', (modulePath, expectedTimeout) => {
    const source = require('fs').readFileSync(require.resolve(modulePath), 'utf8');
    const starts = [];
    for (let i = source.indexOf('messages.create('); i !== -1; i = source.indexOf('messages.create(', i + 1)) {
      starts.push(i);
    }
    expect(starts.length).toBeGreaterThan(0);
    starts.forEach((start, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1] : source.length;
      expect(source.slice(start, end)).toMatch(expectedTimeout);
    });
  });

  test('nothing may reclaim a claim that is still beating', () => {
    // No ceiling, for anybody: every ceiling ultimately steals a live claim,
    // and that duplicates side effects on a customer's record.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const predicate = source.match(/const reclaimableClaim = [^;]+;/s)[0];
    expect(predicate).not.toMatch(/CeilingMinutes/);
    expect(predicate).toContain('CURRENT_BEAT');
  });

  test('the customer checkpoint write is token-fenced and abandons on zero rows', () => {
    // The last ownership gate sits above the whole customer-resolution step,
    // a thousand lines and many awaits back; an unfenced UPDATE there let a
    // superseded pass overwrite the replacement's customer_id, extraction
    // and summary by call id alone (codex #3677 P1).
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const start = source.indexOf('let deferredNonLeadAttributionRetire = false;');
    const end = source.indexOf('const v2ExtractionForAudit', start);
    const checkpoint = source.slice(start, end);
    expect(checkpoint).toContain("const checkpointRows = await db('call_log')");
    expect(checkpoint).toContain(".where('processing_token', procToken)");
    expect(checkpoint).toContain("if (!checkpointRows) return abandonToPeer(");
  });

  test('an ownership loss reported by CSR scoring abandons the pass', () => {
    // scoreCall returns { skipped, reason: 'ownership_lost' } from its own
    // post-await check; reading that as "no score" and carrying on reached
    // the unfenced route-decision insert and ai_validation write.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const start = source.indexOf('await CSRCoach.scoreCall({');
    const end = source.indexOf('csrScoreResult = {', start);
    expect(source.slice(start, end)).toMatch(/scoreResult\.reason === 'ownership_lost'[^;]*\)\s*\{\s*return abandonToPeer\(/);
  });

  test('the recordings list forces only rows that already finished', () => {
    // force changes extraction policy (retry cap, backoff, first-run name
    // auto-apply), so a first-run Process click must send operator alone.
    const path = require('path');
    const panel = require('fs').readFileSync(
      path.join(__dirname, '../../client/src/pages/admin/CallRecordingsPanel.jsx'), 'utf8',
    );
    expect(panel).not.toContain('force: true');
    expect(panel).toContain('force: r.processing_status === "processed"');
  });

  test('the ceiling never reaches the reclaim predicates — those are heartbeat-only', () => {
    // A ceiling that lets a peer take a still-beating claim has to sit above
    // the longest legitimate pass, and the pipeline has unbounded provider
    // calls; set too low it steals live work and duplicates side effects.
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const predicate = source.match(/const reclaimableClaim = [^;]+;/s)[0];
    expect(predicate).toContain('processing_heartbeat_at');
    expect(predicate).not.toMatch(/CeilingMinutes/);
  });


});
