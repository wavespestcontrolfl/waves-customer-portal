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
      expect(CallRecordingProcessor.processRecording).toHaveBeenCalledWith(SID, { force: true });
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
  ])('%s is preceded by an ownership check', (stepMarker, label) => {
    const at = source.indexOf(stepMarker);
    expect(at).toBeGreaterThan(-1);
    // The gate sits immediately before the step, not somewhere upstream.
    const preceding = source.slice(Math.max(0, at - 200), at);
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
    // labeling attempts, two V1 extraction attempts PLUS the CSR scoring leg,
    // the download and the V2 fallback chain — the worst case a HEALTHY pass
    // can reach while holding its claim.
    const expected = PROVIDER_FETCH_TIMEOUTS_MS.recording_download
      + (3 * PROVIDER_FETCH_TIMEOUTS_MS.transcription)
      + (2 * PROVIDER_FETCH_TIMEOUTS_MS.transcript_label)
      + (3 * PROVIDER_FETCH_TIMEOUTS_MS.extraction)
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

// The comms lock bounds only its own acquisition. SET LOCAL lasts to the end
// of the transaction, so a bare set would hand this timeout to every later
// write in a booking or estimate transaction — and `SET LOCAL x = ?` cannot
// bind a parameter at all, so a parameterized restore silently fails and
// leaves the imposed timeout in force.
describe('customer comms lock timeout is scoped and restorable', () => {
  const { lockCustomerComms } = require('../utils/customer-comms-lock');

  const trxSpy = (showValue) => {
    const calls = [];
    return {
      calls,
      raw: jest.fn((sql, bindings) => {
        calls.push({ sql, bindings });
        if (String(sql).includes('SHOW lock_timeout')) {
          return Promise.resolve({ rows: [{ lock_timeout: showValue }] });
        }
        return Promise.resolve({});
      }),
    };
  };

  test('caps an unlimited wait but never widens a stricter one', () => {
    const { shouldCapLockTimeout } = require('../utils/customer-comms-lock');
    // 0 means wait forever — the case the bound exists for.
    expect(shouldCapLockTimeout('0')).toBe(true);
    expect(shouldCapLockTimeout('30s')).toBe(true);
    // A caller's deliberate deadlock or latency guard survives untouched.
    expect(shouldCapLockTimeout('2500ms')).toBe(false);
    expect(shouldCapLockTimeout('5s')).toBe(false);
    // Unreadable: bound it rather than risk an unlimited wait.
    expect(shouldCapLockTimeout('garbage')).toBe(true);
  });

  test('restores through set_config, which can bind — SET LOCAL cannot', async () => {
    const trx = trxSpy('5s');
    await lockCustomerComms(trx, 'cust-1');
    const setters = trx.calls.filter((c) => String(c.sql).includes('lock_timeout'));
    for (const call of setters) {
      // No bare parameterized SET anywhere: postgres rejects it.
      expect(String(call.sql)).not.toMatch(/SET LOCAL lock_timeout = \?/);
    }
    const restore = trx.calls[trx.calls.length - 1];
    expect(String(restore.sql)).toContain("set_config('lock_timeout'");
    expect(restore.bindings).toEqual(['5s']);
  });

  test("preserves '0' — no timeout is a value, not an absence", async () => {
    const trx = trxSpy('0');
    await lockCustomerComms(trx, 'cust-1');
    const restore = trx.calls[trx.calls.length - 1];
    expect(restore.bindings).toEqual(['0']);
  });

  test('restores even when the acquisition times out', async () => {
    const trx = trxSpy('5s');
    trx.raw.mockImplementation((sql, bindings) => {
      trx.calls.push({ sql, bindings });
      if (String(sql).includes('SHOW lock_timeout')) {
        return Promise.resolve({ rows: [{ lock_timeout: '5s' }] });
      }
      if (String(sql).includes('pg_advisory_xact_lock')) {
        return Promise.reject(new Error('canceling statement due to lock timeout'));
      }
      return Promise.resolve({});
    });
    await expect(lockCustomerComms(trx, 'cust-1')).rejects.toThrow(/lock timeout/);
    const restore = trx.calls[trx.calls.length - 1];
    expect(String(restore.sql)).toContain("set_config('lock_timeout'");
  });
});
