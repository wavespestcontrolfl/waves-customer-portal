/**
 * attributeUnclaimedBridgeLeads — "attribute organic if the bridge hasn't
 * claimed it after N days".
 *
 * Calls to the Google Ads call-bridge target number are held out of organic
 * attribution at call time (the bridge gets first claim), but the bridge had
 * claimed ZERO calls ever while 57 leads/90d sat funnel-invisible. This job
 * declares leads still on a bridge-target lead_sources row (a claim repoints
 * lead_source_id, so claimed leads self-exclude) with no funnel row after the
 * window organic, via the normal recordCallPpcAttribution path.
 */

let listByTable = {};
let firstByTable = {};
let listRejectsByTable = {}; // table -> awaited list query rejects (outage)
let txnRejects = false; // per-lead transaction throws (codex P2 r29)
const insertCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  const self = () => b;
  [
    'where', 'whereIn', 'whereRaw', 'whereNotNull', 'whereNull', 'whereNotExists', 'whereNot',
    'forUpdate', 'select', 'orderBy', 'limit', 'onConflict', 'ignore', 'merge', 'update',
  ].forEach((m) => { b[m] = jest.fn(self); });
  // Real knex .modify invokes the callback with the builder.
  b.modify = jest.fn((fn) => { fn(b); return b; });
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.insert = jest.fn((row) => { insertCalls.push({ table, row }); return b; });
  b.then = (res, rej) => {
    if (listRejectsByTable[table]) return Promise.reject(new Error('db down')).then(res, rej);
    return Promise.resolve(
      listByTable[table] !== undefined ? listByTable[table] : [1],
    ).then(res, rej);
  };
  return b;
});
// The sweep now runs each candidate through a locked transaction (lead
// FOR UPDATE re-read + provenance resolution + funnel write on one
// connection) — the mock passes the same builder through.
mockDb.transaction = jest.fn(async (fn) => {
  if (txnRejects) throw new Error('txn down');
  return fn(mockDb);
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '2026-07-01'),
}));
// Bridge target = the shared Bradenton number, format-agnostic (mirrors
// google-call-bridge.isBridgeTargetNumber's last-10 semantics).
jest.mock('../services/ads/google-call-bridge', () => ({
  isBridgeTargetNumber: (p) => String(p || '').replace(/\D/g, '').endsWith('9413187612'),
}));

const { attributeUnclaimedBridgeLeads } = require('../services/ads/call-attribution');

const BRIDGE_SOURCE = {
  id: 'src-bridge',
  name: 'Website — Bradenton (city page)',
  source_type: 'main_site',
  twilio_phone_number: '+19413187612',
};
const OTHER_SOURCE = {
  id: 'src-parrish',
  name: 'Website — Parrish (city page)',
  source_type: 'main_site',
  twilio_phone_number: '+19412972817',
};

beforeEach(() => {
  jest.clearAllMocks();
  listByTable = {};
  firstByTable = {};
  listRejectsByTable = {};
  txnRejects = false;
  insertCalls.length = 0;
  // Provenance resolution's sid/stamp candidate queries — default to no
  // linked calls (provenance NULL, permanently conservative).
  listByTable.call_log = [];
});

describe('attributeUnclaimedBridgeLeads', () => {
  test('records an organic waves_website funnel row for an unclaimed bridge lead', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE, OTHER_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-1',
      customer_id: 'c1',
      service_interest: 'pest control',
      first_contact_at: '2026-06-11T14:00:00Z',
      created_at: '2026-06-11T14:00:00Z',
      lead_source_id: 'src-bridge',
    }];
    // The locked FOR UPDATE re-read inside the per-lead transaction.
    firstByTable['leads as l'] = {
      id: 'lead-1',
      customer_id: 'c1',
      lead_source_id: 'src-bridge',
      service_interest: 'pest control',
      first_contact_at: '2026-06-11T14:00:00Z',
      created_at: '2026-06-11T14:00:00Z',
      twilio_call_sid: null,
    };

    const res = await attributeUnclaimedBridgeLeads({ olderThanDays: 7 });

    expect(res).toEqual({ candidates: 1, recorded: 1, skipped: 0, failed: 0 });
    const row = insertCalls.find((c) => c.table === 'ad_service_attribution').row;
    expect(row).toMatchObject({
      lead_id: 'lead-1',
      customer_id: 'c1',
      lead_source: 'waves_website',       // main_site → shared map channel
      lead_source_detail: BRIDGE_SOURCE.name,
      funnel_stage: 'lead',
      is_paid: false,                     // unclaimed ⇒ organic
      lead_date: '2026-06-11',            // dated by the call, not the run
    });
  });

  test('customer-less lead is skipped by the no_customer gate (matches live call path)', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-anon', customer_id: null, created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    firstByTable['leads as l'] = {
      id: 'lead-anon', customer_id: null, created_at: '2026-06-01', lead_source_id: 'src-bridge', twilio_call_sid: null,
    };
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1, failed: 0 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('no bridge-target lead_sources rows → no-op zeros', async () => {
    listByTable.lead_sources = [OTHER_SOURCE];
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 0, recorded: 0, skipped: 0, failed: 0 });
    expect(mockDb).not.toHaveBeenCalledWith('leads as l');
  });

  test('unmapped source_type fails closed — no funnel row', async () => {
    listByTable.lead_sources = [{ ...BRIDGE_SOURCE, source_type: 'tollfree' }];
    listByTable['leads as l'] = [{
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1, failed: 0 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('an existing funnel row for the lead is not duplicated (dedupe via recordCallPpcAttribution)', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    firstByTable['leads as l'] = {
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge', twilio_call_sid: null,
    };
    // recordCallPpcAttribution's lead_id lookup finds a row owned by another source
    firstByTable.ad_service_attribution = { id: 'asa-1', lead_source: 'google_ads' };
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1, failed: 0 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('a source-scan failure reports scanFailed — an outage is not a quiet day (codex P2 r29)', async () => {
    // The internal catch returned a zeroed summary the cron read as a
    // healthy tick with zero work — same class as the transfer sweep's
    // r16 finding.
    listRejectsByTable.lead_sources = true;
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 0, recorded: 0, skipped: 0, failed: 0, scanFailed: true });
    expect(insertCalls).toHaveLength(0);
  });

  test('a per-lead failure counts in failed, NOT skipped — a wedged sweep is distinguishable from a cautious one (codex P2 r29)', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    txnRejects = true;
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 0, failed: 1 });
  });
});

describe('scheduler wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');

  test('fallback runs INSIDE the 6:20 bridge cron, after applyBridge, under one shared lease', () => {
    // One cron body, one runExclusive: the fallback can never run while a
    // bridge scan is mid-claim, and a deploy-overlap instance skips the pair
    // atomically — never the fallback without the bridge.
    expect(src).toMatch(/runExclusive\('google-call-bridge-organic'/);
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 7000);
    const bridgeIdx = block.indexOf('applyBridge');
    const sweepIdx = block.indexOf('attributeUnclaimedBridgeLeads');
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(bridgeIdx); // strict order: claim, then fallback
    expect(block).toMatch(/BRIDGE_UNCLAIMED_ORGANIC_DISABLED/);
    expect(block).toMatch(/BRIDGE_UNCLAIMED_ORGANIC_DAYS/);
    // No separate fallback cron remains: exactly one require + one call site,
    // both inside this block.
    expect(src.match(/attributeUnclaimedBridgeLeads/g)).toHaveLength(2);
    expect(block.match(/attributeUnclaimedBridgeLeads/g)).toHaveLength(2);
  });

  test('fallback requires a COMPLETE healthy bridge pass — outage, row cap, or write failure blocks it', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 7000);
    expect(block).toMatch(/bridgeBlockedReason = 'scan_failed'/);
    expect(block).toMatch(/bridgeBlockedReason = 'row_cap_hit'/);
    expect(block).toMatch(/bridgeBlockedReason = 'bridge_write_failed'/);
    // Unconfigured API fails closed (rotated secret ≠ organic-only install);
    // genuine no-Google-Ads installs opt in explicitly.
    expect(block).toMatch(/bridgeBlockedReason = 'google_ads_unconfigured'/);
    expect(block).toMatch(/BRIDGE_UNCLAIMED_ALLOW_UNCONFIGURED/);
    expect(block).toMatch(/if \(bridgeBlockedReason\)/);
    expect(block.indexOf('if (bridgeBlockedReason)')).toBeLessThan(block.indexOf('attributeUnclaimedBridgeLeads'));
  });

  test('ambiguous matches exclude ONLY their linked leads from the fallback — scoped, not a global block (codex P1 r14 + pre-push P1 r18)', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 12000);
    // Candidate calls collected from the day's ambiguous matches (best +
    // alternatives) and passed to the sweep; no global bridgeBlockedReason
    // arm — one persistent shared-SID ambiguity must not starve every
    // unrelated organic lead.
    expect(block).toMatch(/skipReason === 'ambiguous'/);
    expect(block).toMatch(/organicExclusions/);
    expect(block).toMatch(/attributeUnclaimedBridgeLeads\(\{ olderThanDays: days, \.\.\.organicExclusions \}\)/);
    expect(block).not.toMatch(/bridgeBlockedReason = 'ambiguous_matches'/);
    // Sweep side: NULL-sid leads must PASS the sid exclusion arm (a bare
    // whereNotIn silently drops NULL rows), and the stamp arm excludes too.
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1];
    expect(sweep).toMatch(/whereNull\('l\.twilio_call_sid'\)\.orWhereNotIn\('l\.twilio_call_sid', excludeCallSids\)/);
    expect(sweep).toMatch(/whereIn\('cla\.id', excludeCallIds\)/);
  });

  test('the PHONE-reuse linkage arm excludes ambiguous-linked leads too (codex P1 r18)', () => {
    // findReusableCallLead links a phone-bearing call to an existing lead
    // WITHOUT touching the lead's sid or writing a stamp — the sid/stamp
    // arms alone let the sweep organically classify a lead whose only
    // linked call carries strong-but-ambiguous paid evidence.
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1].split('.orderBy(')[0];
    const phoneArm = sweep.split('function phoneLinkedCallAmbiguous')[1];
    expect(phoneArm).toBeTruthy();
    expect(phoneArm).toMatch(/whereIn\('clp\.id', excludeCallIds\)/);
    // CALLER leg only — the dialed leg is the shared office number and
    // would exclude every bridge-target lead.
    expect(phoneArm).toMatch(/clp\.from_phone/);
    expect(phoneArm).not.toMatch(/clp\.to_phone/);
    // NULL/short lead phones must PASS the arm (same rule as NULL-sid).
    expect(phoneArm).toMatch(/LENGTH\(regexp_replace\(COALESCE\(l\.phone, ''\)/);
  });

  test('a bridge-pair failure is rethrown AFTER the transfer sweep (codex P2, PR #3303 r15)', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 12000);
    // Captured, not swallowed: the sweep still runs, then the failure
    // surfaces so the lease's job-health record counts the failed tick.
    expect(block).toMatch(/bridgePairError = err/);
    expect(block).toMatch(/if \(bridgePairError\) throw bridgePairError/);
    expect(block.indexOf('sweepPendingAttributionTransfers')).toBeLessThan(block.indexOf('if (bridgePairError) throw bridgePairError'));
  });

  test('transfer-sweep degradation surfaces in job health too (codex P2, PR #3303 r16)', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 12000);
    // The sweep degrades internally (scan catch → scanFailed, per-row
    // catches → summary.failed) — the cron inspects the summary and throws
    // so a stalled retry lane cannot masquerade as a healthy tick.
    expect(block).toMatch(/s\.scanFailed/);
    expect(block).toMatch(/s\.failed > 0/);
    expect(block).toMatch(/if \(sweepError\) throw sweepError/);
  });

  test('ORGANIC-pass degradation surfaces in job health too, never masking a bridge error (codex P2 r29)', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 12000);
    // attributeUnclaimedBridgeLeads degrades internally the same way
    // (source-scan catch → scanFailed, per-lead catches → failed) — the
    // cron must inspect ITS summary as well, or a persistent organic
    // outage records healthy ticks forever.
    expect(block).toMatch(/if \(s\.scanFailed\) organicError = new Error\('\[bridge-unclaimed\] source scan failed'\)/);
    expect(block).toMatch(/else if \(s\.failed > 0\) organicError = new Error/);
    expect(block).toMatch(/if \(organicError\) throw organicError/);
    // Precedence: bridge error first, then organic, then the transfer sweep.
    expect(block.indexOf('if (bridgePairError) throw bridgePairError'))
      .toBeLessThan(block.indexOf('if (organicError) throw organicError'));
    expect(block.indexOf('if (organicError) throw organicError'))
      .toBeLessThan(block.indexOf('if (sweepError) throw sweepError'));
  });

  test('organic-candidate eligibility is re-applied under the lead lock (codex P1+P2, PR #3303 r14/r16)', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1];
    const lockedRead = sweep.split('const locked = await trx')[1].slice(0, 1200);
    expect(lockedRead).toMatch(/whereNull\('l\.deleted_at'\)/);
    // Terminal-status exclusion under the lock: an admin marking the lead
    // duplicate/disqualified/spam mid-wait must not receive the row.
    expect(lockedRead).toMatch(/COALESCE\(l\.status,''\) NOT IN \('duplicate','disqualified','spam'\)/);
    expect(sweep).toMatch(/const applyAmbiguityExclusions = /);
  });

  test('ambiguity exclusions run in a SECOND statement AFTER the lock, never inside it (codex P1 r23)', () => {
    // The arms are correlated call_log subqueries; under READ COMMITTED a
    // single combined statement evaluates them against the snapshot taken
    // before it blocked on the lead lock, so a force-reprocess that linked
    // an ambiguous paid call could still be missed.
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1];
    const lockStmt = sweep.split('const locked = await trx')[1].split(';')[0];
    expect(lockStmt).toMatch(/forUpdate\(\)/);
    expect(lockStmt).not.toMatch(/applyAmbiguityExclusions/);
    // ...and the recheck follows, gated on its own miss.
    const after = sweep.split('if (!locked) return')[1].slice(0, 1400);
    expect(after).toMatch(/const stillUnambiguous = await trx\('leads as l'\)/);
    expect(after).toMatch(/\.modify\(applyAmbiguityExclusions\)/);
    expect(after).not.toMatch(/forUpdate\(\)/); // the lock is already held
    expect(after).toMatch(/reason: 'ambiguous_matches'/);
  });

  test('successor discovery covers stamp, sid AND ownership-gated phone reuse (pre-push P0 r20)', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const fn = ca.split('async function findSettledSuccessorCall')[1].split('async function retireCallAttributionRow')[0];
    // Phone arm: shared-number guard (another live lead on the number
    // disables it), both call legs, dissent-yield, and the
    // both-set-and-differ ownership gate.
    expect(fn).toMatch(/RIGHT\(regexp_replace\(COALESCE\(phone, ''\)/); // shared-lead guard on leads.phone
    expect(fn).toMatch(/from_phone/);
    expect(fn).toMatch(/to_phone/);
    expect(fn.match(/whereNot\(settledDissentingStamp\)/g).length).toBe(2); // sid + phone arms
    expect(fn).toMatch(/whereNull\('customer_id'\)\.orWhere\('customer_id', lead\.customer_id\)/);
    expect(fn).toMatch(/\.forUpdate\(\)/); // locked selection (P1 r19)
  });

  test('selection excludes deleted and customer-less leads (codex P1+P2, PR #3303 r14)', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1];
    // Soft-deleted leads must not gain organic funnel rows — selection AND
    // the locked reread.
    expect(sweep).toMatch(/\.whereNull\('l\.deleted_at'\)/);
    expect(sweep).toMatch(/\.whereNull\('deleted_at'\)/);
    // Customer-less leads defer to the claim-time backfill instead of
    // occupying the limited oldest-first window with daily no_customer
    // refusals.
    expect(sweep).toMatch(/\.whereNotNull\('l\.customer_id'\)/);
  });

  test('manual admin bridge-apply is serialized under the same lease', () => {
    const adminSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-ads.js'), 'utf8');
    const applyBlock = adminSrc.split("'/call-bridge/apply'")[1].slice(0, 1200);
    expect(applyBlock).toMatch(/runExclusive\('google-call-bridge-organic'/);
    expect(applyBlock).toMatch(/status\(409\)/); // lease held → busy, not silent no-op
  });

  test('selection is limited to CALL leads (web leads got their funnel row at webhook time)', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    expect(ca).toMatch(/\.where\('l\.first_contact_channel', 'call'\)/);
  });

  test('a bridge-claimed call_log row excludes its lead even when the lead was never repointed', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    expect(ca).toMatch(/anyLinkedCallAlreadyBridged/);
    // call_log has NO lead_id column — linkage is expressed by the shared
    // predicate below (prod-schema-verified 2026-07-01).
    expect(ca).not.toMatch(/clb\.lead_id\b/);
    expect(ca).toMatch(/whereNotNull\('clb\.google_ads_call_resource_name'\)/);
  });

  test('BOTH sweep guards compose the one shared linkage predicate — PERSISTED modes only (codex P1 r24/r25)', () => {
    // Four consecutive rounds found the same root gap on successive
    // surfaces: sid + metadata stamp are only two of the modes. A
    // phone-reused lead has neither, and the bridge keeps its own
    // association in metadata.google_ads_call_bridge.leadMatch.
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const helper = ca.split('const linkedCallToLead = (qb, a) => {')[1].split('};')[0];
    expect(helper).toMatch(/twilio_call_sid = l\.twilio_call_sid/);
    expect(helper).toMatch(/metadata->>'lead_id' = l\.id::text/);
    expect(helper).toMatch(/google_ads_call_bridge'->'leadMatch'->>'leadId' = l\.id::text/);
    // NO bare phone arm (codex P1 r25): a permanently-bridged or
    // permanently-rejected old call on a reused number would suppress a
    // later distinct lead's attribution forever, not merely delay it.
    expect(helper).not.toMatch(/from_phone/);
    // Composed by both guards, and the old duplicated arms are gone.
    expect(ca).toMatch(/linkedCallToLead\(this, 'clb'\)/);
    expect(ca).toMatch(/linkedCallToLead\(this, 'clr'\)/);
    expect(ca).not.toMatch(/function stampedCallAlreadyBridged/);
    expect(ca).not.toMatch(/function stampedCallNotAttributable/);
  });
});

// Codex P1 r23 — the three fixes that live outside call-attribution.js.
describe('r23 ambiguity + linkage completeness', () => {
  const fs = require('fs');
  const path = require('path');
  const bridge = fs.readFileSync(path.join(__dirname, '../services/ads/google-call-bridge.js'), 'utf8');
  const sched = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');

  test('the exclusion set is built from EVERY qualifying candidate, not the two-item display preview', () => {
    // buildMatches truncates `alternatives` to slice(1, 3) for the UI; a
    // fourth equally plausible paid candidate must still be excluded.
    expect(bridge).toMatch(/const ambiguousCandidates = ambiguous/);
    expect(bridge).toMatch(/best\.score - c\.score < AMBIGUITY_SCORE_MARGIN/);
    // The margin is named once and shared with the ambiguity test itself.
    expect(bridge).toMatch(/const AMBIGUITY_SCORE_MARGIN = 10;/);
    expect(bridge).not.toMatch(/best\.score - second\.score < 10\b/);
    // The sweep reads the complete set, with the preview only as fallback.
    expect(sched).toMatch(/\(m\.ambiguousCandidates \|\| \[\]\)\.length/);
  });

  test('the cleared-link proof also checks provenance and stamp-less phone linkage', () => {
    const proof = bridge.split("return { match: null, reason: 'linkage_cleared' };")[0].slice(-2200);
    // Exact proof first: this call's own funnel row on a live lead.
    expect(proof).toMatch(/\.where\('a\.source_call_id', callLog\.id\)/);
    expect(proof).toMatch(/whereNull\('l\.deleted_at'\)/);
    // Then the deliberately broad caller-phone arm — any doubt WAITS.
    expect(proof).toMatch(/callerTen/);
    expect(proof).toMatch(/RIGHT\(regexp_replace\(COALESCE\(phone, ''\)/);
    // Both report the TRANSIENT reason, never a clear.
    const armReasons = proof.match(/reason: '(lead_not_live|linkage_cleared)'/g) || [];
    expect(armReasons).toContain("reason: 'lead_not_live'");
  });
});
