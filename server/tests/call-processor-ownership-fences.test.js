// Ownership-fence contract for processRecording.
//
// Every durable call_log write a pass makes AFTER acquiring its claim must
// carry the processing_token fence: a worker whose heartbeats failed (the
// 2026-08-29 pool exhaustion) loses the claim to a peer and later resumes
// with a stale extraction in hand. Unfenced writes let it overwrite the
// owning pass's results — the V2 extraction and ai_validation writes did
// exactly that until this contract existed. The scan reads the source so a
// new write cannot ship unfenced by accident; the allowlist names the one
// write whose own column is its fence.
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

function processRecordingBody() {
  const start = source.indexOf('  async processRecording(callSid, opts = {}) {');
  const end = source.indexOf('      if (heartbeatTimer) clearInterval(heartbeatTimer);', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { body: source.slice(start, end), start };
}

function callLogUpdates(body, start) {
  const out = [];
  const re = /db\('call_log'\)/g;
  let m;
  while ((m = re.exec(body))) {
    const chain = body.slice(m.index, m.index + 900);
    const upd = chain.indexOf('.update(');
    const firstTerminal = Math.min(
      ...['.first(', '.select(', '.insert(', '.del(', '.count(']
        .map((t) => chain.indexOf(t))
        .filter((i) => i >= 0)
        .concat([chain.length]),
    );
    if (upd >= 0 && upd < firstTerminal) {
      const where = chain.slice(0, upd);
      out.push({
        line: source.slice(0, start + m.index).split('\n').length,
        where,
      });
    }
  }
  return out;
}

// The voicemail-callback bell claim is an at-most-once CAS on its own
// column: whichever pass wins it, the bell rings exactly once for the call.
const OWN_COLUMN_FENCES = ["whereNull('voicemail_callback_alerted_at')"];

describe('processRecording call_log writes are ownership-fenced', () => {
  const { body, start } = processRecordingBody();
  const updates = callLogUpdates(body, start);

  test('the scan sees the writes it is meant to guard', () => {
    // A refactor that renamed the handle or the method must not turn this
    // contract into a vacuous pass.
    expect(updates.length).toBeGreaterThanOrEqual(15);
  });

  test('every post-claim update carries the processing_token (or generation) fence', () => {
    const unfenced = updates.filter((u) => {
      if (/processing_token|processing_generation/.test(u.where)) return false;
      return !OWN_COLUMN_FENCES.some((allow) => u.where.includes(allow));
    });
    expect(unfenced.map((u) => `L${u.line}: ${u.where.replace(/\s+/g, ' ').slice(0, 120)}`)).toEqual([]);
  });

  test('the stage writes that sit right after a provider await are fenced and stop the pass', () => {
    // V2 persist + provenance stamp on failure, the voicemail channel stamp,
    // the two Twilio fallback transcript writes, ai_validation. Each is a
    // write the pre-fix code performed by id alone after a multi-minute
    // await.
    expect(body).toContain("const v2Stored = await db('call_log').where({ id: call.id }).where('processing_token', procToken).update(v2Update);");
    expect(body).toContain("if (!(await stillOwnsClaim())) return abandonToPeer('the V2 extraction persist');");
    expect(body).toContain("if (voicemailStamped === 0) return abandonToPeer('the voicemail channel stamp');");
    expect(body).toContain("if (fallbackStored === 0) return abandonToPeer('the Twilio fallback transcript write');");
    expect(body).toContain("if (cachedStored === 0) return abandonToPeer('the cached Twilio transcript write');");
    const aiValidationAt = body.indexOf('ai_validation: JSON.stringify(validationPayload)');
    expect(aiValidationAt).toBeGreaterThan(-1);
    expect(body.slice(aiValidationAt - 200, aiValidationAt)).toContain(".where('processing_token', procToken)");
  });

  test('the customer checkpoint honours the LATEST operator link, read inside the write', () => {
    // A relink made while the pass runs must not be overwritten by the
    // pass's snapshot of the override taken at claim time.
    const at = body.indexOf("'customer_link_override')\"\n        + \" THEN NULLIF(metadata -> 'customer_link_override' ->> 'customer_id', '')::uuid ELSE ?::uuid END\"");
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at - 400, at + 200)).toContain("jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'customer_link_override')");
    // The phantom-customer unlink never clears a person's link either.
    const unlinkAt = body.indexOf(".update({ customer_id: null, updated_at: new Date() });");
    expect(unlinkAt).toBeGreaterThan(-1);
    expect(body.slice(unlinkAt - 300, unlinkAt)).toContain("NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'customer_link_override')");
  });

  test('commitments are recorded after finalization, fenced on the pass generation, from the V2 extraction + transcript only (no V1, no disposition)', () => {
    const zeroTriageAt = body.indexOf('await applyZeroTriageLayers({');
    const commitmentsAt = body.indexOf("require('./call-commitments').recordCallCommitments({");
    expect(zeroTriageAt).toBeGreaterThan(-1);
    expect(commitmentsAt).toBeGreaterThan(zeroTriageAt);
    const callSite = body.slice(commitmentsAt, commitmentsAt + 700);
    expect(callSite).not.toContain('disposition');
    expect(callSite).not.toContain('v1:');
    expect(callSite).toContain('transcript: transcription');
    expect(callSite).toContain('procGeneration,');
    expect(callSite).not.toContain('procToken');
  });

  test('an explicit operator unlink stops the pass from finding or minting a customer, not only from writing the link back', () => {
    expect(body).toContain("const explicitUnlink = !!customerLinkOverride && !customerLinkOverride.customer_id;");
    // The one branch that finds-or-creates a customer from the caller's
    // phone/name is guarded by it; the name-reconciliation branch already
    // skips any override.
    expect(body).toContain('if (!customerId && phone && !explicitUnlink) {');
    expect(body).toContain('if (customerId && extracted.first_name && phone && !customerLinkOverride) {');
    // …and a customer-less result under an explicit unlink is intentional,
    // never customer_creation_failed.
    expect(body).toContain("!v2NonCustomerCallNature && !explicitUnlink);");
  });

  test('the customer timeline entry is exactly-once per call in Postgres, not by a check-then-insert', () => {
    // One statement: the insert is fenced on the processing token AND
    // exactly-once on the call_log_id partial unique index — a stale pass
    // that lost its claim between the check and the write inserts nothing.
    const at = body.indexOf('INSERT INTO customer_interactions (customer_id, interaction_type, subject, body, metadata)');
    expect(at).toBeGreaterThan(-1);
    const stmt = body.slice(at, at + 900);
    expect(stmt).toContain('WHERE EXISTS (SELECT 1 FROM call_log WHERE id = ? AND processing_token = ? FOR UPDATE)');
    expect(stmt).toContain("ON CONFLICT ((metadata ->> 'call_log_id')) WHERE interaction_type = 'call' AND metadata ->> 'call_log_id' IS NOT NULL DO NOTHING");
    expect(stmt).toContain('call.id,\n          procToken,');
    expect(body).not.toContain('timelineExists');
  });

  test('a pass that processed an adopted recording closes its review card unless another parked recording still waits', () => {
    const at = body.indexOf("if (written > 0 && finalStatus === 'processed') {");
    expect(at).toBeGreaterThan(-1);
    const site = body.slice(at, at + 1800);
    expect(site).toContain("const nowRow = await trx('call_log').where({ id: call.id }).first('metadata');");
    expect(site).toContain("m?.adopted_recording?.recording_sid");
    expect(site).toContain("adopted === call.recording_sid");
    expect(site).toContain("r.parked_because !== 'replaced_by_operator'");
    expect(site).toContain("reason_code: 'additional_recording'");
    // …and clears the call's review flag when that was the last open card
    // (hook P1 on #3764 d9ee6ba35): the deferred path mirrors the route's settle.
    const after = body.slice(at, at + 2600);
    expect(after).toContain("resolution_note: `Adopted ${adopted} processed` });");
    expect(after.indexOf(".update({ review_status: null });")).toBeGreaterThan(after.indexOf("resolution_note: `Adopted ${adopted} processed` });"));
  });

  test('the oldest-unfinished metric counts a PAN-quarantined call with a stored transcript (codex #3736 gh-r18 P2)', () => {
    const at = source.indexOf('as oldest_unfinished_minutes');
    expect(at).toBeGreaterThan(-1);
    const stat = source.slice(at - 700, at);
    expect(stat).toContain("OR ((transcription_metadata::jsonb ->> 'pan_detected') = 'true' AND transcription IS NOT NULL)");
    expect(stat).toContain("(NULLIF(btrim(recording_url), '') IS NOT NULL AND COALESCE(recording_duration_seconds, duration_seconds, 0) > 10)");
  });

  test('the retrying stat mirrors the sweep\'s media and duration eligibility (codex #3736 gh-r16 P2)', () => {
    const at = source.indexOf(') as retrying"');
    expect(at).toBeGreaterThan(-1);
    const stat = source.slice(source.lastIndexOf('db.raw(`COUNT(*) FILTER (WHERE (processing_status = \'no_transcription\'', at), at);
    expect(stat).toContain("NULLIF(btrim(recording_url), '') IS NOT NULL OR ((transcription_metadata::jsonb ->> 'pan_detected') = 'true' AND transcription IS NOT NULL)");
    expect(stat).toContain("COALESCE(recording_duration_seconds, duration_seconds, 0) > 10 OR (transcription_metadata::jsonb ->> 'pan_detected') = 'true'");
    expect(stat).toContain('${Number(EXTRACTION_RETRY_WINDOW_DAYS)} days');
  });

  test('every provenance write goes through the SQL-side quarantine carry; the read-merge-write helper is gone (codex #3736 gh-r15 P1)', () => {
    expect(source).not.toContain('withPanStamps');
    expect((source.match(/transcription_metadata: transcriptionMetadataWrite\(/g) || []).length).toBe(5); // Includes both rejected-recording and absent-recording relay rewrites.
    expect(source).toContain('const rejectionMeta = transcriptionMetadataWrite({ ...priorMeta, transcription_rejected: true');
    const webhook = fs.readFileSync(require.resolve('../routes/twilio-voice-webhook'), 'utf8');
    expect(webhook).not.toContain('withPanStamps');
    expect(webhook).toContain('transcription_metadata: CallProc.transcriptionMetadataWrite({');
    // The PAN sweep derives a SID from a listed entry's URL.
    expect(source).toContain("const parkedSid = entry?.recording_sid || sidFromRecordingUrl(entry?.recording_url);");
  });

  test('the post-claim refresh reloads the stamps a swap clears, and the timeline insert locks the claim row in its fence (codex #3736 gh-r14)', () => {
    const at = body.indexOf("const claimedRow = await db('call_log').where({ id: call.id }).first(");
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, at + 400)).toContain("'transcription_status', 'answered_by', 'call_outcome',");
    expect(body).toContain('WHERE EXISTS (SELECT 1 FROM call_log WHERE id = ? AND processing_token = ? FOR UPDATE)');
  });

  test('a processed pass resolves an earlier lead_creation_failed card the same way (codex #3736 gh-r13)', () => {
    const at = body.indexOf("if (written > 0 && finalStatus === 'processed') {\n        // The same repair for an earlier lead_creation_failed");
    expect(at).toBeGreaterThan(-1);
    const site = body.slice(at, at + 1400);
    expect(site).toContain("reason_code: 'lead_creation_failed'");
    expect(site).toContain("resolution_note: 'Lead landed on a later pass'");
    expect(site).toContain(".update({ review_status: null })");
  });

  test('the recovery sweep selects a quarantine with owed SIDs, and a not-ready deferral after a pre-claim recording change restores pending, not the discarded recording\'s status (codex #3736 gh-r13)', () => {
    expect(source).toContain("OR COALESCE(jsonb_array_length(transcription_metadata::jsonb -> 'quarantine_owed_sids'), 0) > 0)");
    expect(body).toContain("const preClaimStatus = (call.processing_status === 'processing' || recordingChangedBeforeClaim) ? null : (call.processing_status || null);");
    expect(body).toContain("recordingChangedBeforeClaim = true;");
  });

  test('a customer that lands on a later pass resolves the customer_creation_failed card and clears review only when nothing else is open', () => {
    const at = body.indexOf("if (written > 0 && finalStatus === 'processed' && (customerLanded || !customerExpected)) {");
    expect(at).toBeGreaterThan(-1);
    const site = body.slice(at, at + 1200);
    expect(site).toContain("reason_code: 'customer_creation_failed'");
    expect(site).toContain("resolution_note: 'Customer landed on a later pass'");
    expect(site).toContain(".whereNotExists(trx('triage_items')");
    expect(site).toContain('.update({ review_status: null })');
  });

  test('customer_creation_failed opens review and files its card — it is no longer a silent terminal', () => {
    expect(body).toContain("finalStatus === 'customer_creation_failed'\n            ? { review_status: 'open' } : {}");
    // The card is filed INSIDE the finalization transaction, fenced by the
    // status write it describes — never after the token is cleared.
    const cardAt = body.indexOf("flag: 'customer_creation_failed',");
    expect(cardAt).toBeGreaterThan(-1);
    expect(body.slice(cardAt - 400, cardAt)).toContain("if (written > 0 && finalStatus === 'customer_creation_failed') {");
    expect(body.slice(cardAt - 400, cardAt)).toContain("await trx('triage_items').insert(buildTriageItem({");
    expect(body.indexOf("return written;", cardAt)).toBeGreaterThan(cardAt);
    const gates = fs.readFileSync(require.resolve('../services/call-routing-gates'), 'utf8');
    expect(gates).toContain("customer_creation_failed: 'customer_field_conflict',");
    expect(gates).toContain("additional_recording: 'service_unknown',");
  });
});

// The recording-status webhook's replace fence refuses a swap only while
// the row is load-bearing, so the recording loaded BEFORE the claim can be
// replaced before the claim lands. The post-claim re-read must therefore
// reload the recording and transcript columns, not just metadata — or the
// pass transcribes the superseded audio against a row that now holds the
// replacement (codex #3736 gh-r5).
describe('processRecording re-reads the recording it is accountable for after the claim', () => {
  const { body } = processRecordingBody();
  const reread = body.indexOf("const claimedRow = await db('call_log').where({ id: call.id }).first(");
  test('the post-claim read exists and selects the recording + transcript columns', () => {
    expect(reread).toBeGreaterThan(-1);
    const stmt = body.slice(reread, body.indexOf(');', reread));
    for (const col of ['metadata', 'recording_url', 'recording_sid', 'transcription', 'transcription_provider', 'transcript_structured', 'transcription_metadata']) {
      expect(stmt).toContain(`'${col}'`);
    }
    expect(body.slice(reread, reread + 1200)).toContain('Object.assign(call, claimedRow)');
  });
  test('the re-read happens after the claim and before the recording is transcribed', () => {
    const claim = body.indexOf("processing_token: procToken,");
    const transcribe = body.indexOf('await transcribeRecording(call.recording_url');
    expect(claim).toBeGreaterThan(-1);
    expect(transcribe).toBeGreaterThan(reread);
    expect(reread).toBeGreaterThan(claim);
  });
});

// An operator adopting a recording claims FOR that recording: both claim
// writes (automatic and force) carry the expected-recording predicate, and a
// refused claim whose recording moved reports recording_changed rather than
// already_processing (codex #3736 gh-r6).
describe('processRecording claims are fenced to the expected recording when one is given', () => {
  const { body } = processRecordingBody();
  test('both claim writes carry the expectedRecordingSid predicate', () => {
    const fence = "if (opts.expectedRecordingSid) this.where('recording_sid', opts.expectedRecordingSid);";
    const first = body.indexOf(fence);
    const second = body.indexOf(fence, first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Each fence sits inside a claim chain: the next .update( after it sets processing_token.
    for (const at of [first, second]) {
      const upd = body.indexOf('.update(', at);
      expect(body.slice(upd, upd + 300)).toContain('processing_token: procToken');
    }
  });
  test('a blocked claim re-reads the recording and reports recording_changed when it moved', () => {
    const blocked = body.indexOf('if (claimBlocked) {');
    const branch = body.slice(blocked, blocked + 900);
    expect(branch).toContain("first('recording_sid')");
    expect(branch).toContain("reason: 'recording_changed'");
  });
});

// A replaced recording's pass must write its OWN route decision: the audit
// key includes the recording, both inserts target that key, and the same-run
// outcome update addresses this recording's row only (codex #3736 gh-r7).
describe('route decisions are keyed on the recording they were derived from', () => {
  const { body } = processRecordingBody();
  test('both route_decisions inserts are targetless DO NOTHING (no constraint named — rolling-deploy safe) and pass the recording', () => {
    const inserts = body.match(/route_decisions'\)[\s\S]{0,120}?\.onConflict\(([^)]*)\)/g) || [];
    expect(inserts.length).toBe(2);
    for (const i of inserts) expect(i).toMatch(/\.onConflict\(\)$/);
    expect((body.match(/recordingSid: call\.recording_sid/g) || []).length).toBe(2);
  });
  test('the same-run outcome update is scoped to this recording', () => {
    const upd = body.indexOf("final_action_taken: bookedServiceId ? 'auto_route' : 'auto_route_skipped'");
    expect(upd).toBeGreaterThan(-1);
    expect(body.slice(upd - 400, upd)).toContain("recording_sid: call.recording_sid || ''");
  });
});

// An explicit operator unlink covers the lead as well as the customer: a
// reprocess must not mint or reuse a customer-less lead from the call's
// phone (codex #3736 gh-r8).
describe('an explicit unlink gates lead creation', () => {
  const { body } = processRecordingBody();
  test('the known-caller hint follows the operator link — the override target, or none after an explicit unlink (codex #3764 gh-r2 P1)', () => {
    const at = body.indexOf('const knownCustomer = customerLinkOverride');
    expect(at).toBeGreaterThan(-1);
    const site = body.slice(at, at + 400);
    expect(site).toContain("await db('customers').where({ id: customerLinkOverride.customer_id }).whereNull('deleted_at').first()");
    expect(site).toContain(': null)');
    expect(site).toContain(': await findCustomerForCallContact(contactPhone, {});');
    // The override is resolved BEFORE Step 2 reads it.
    expect(body.indexOf('const customerLinkOverride = (() => {')).toBeLessThan(at);
  });

  test('an adoption carries the pre-swap completed state into the lead first-contact clamp through the row stamp, so the sweep\'s retries see it too (codex #3764 gh-r2 + gh-r4 P2)', () => {
    expect(body).toContain("COMPLETED_STATUSES.has(adoptedStamp.previous_processing_status)");
    expect(body).toContain("adoptedStamp.recording_sid === (call.recording_sid || null)");
    expect(body).toContain("const wasAlreadyProcessed = COMPLETED_STATUSES.has(call.processing_status) || adoptedOverCompleted;");
    expect(body).not.toContain('opts.reprocessOfProcessed');
  });

  test('workableUnnamedLead consults explicitUnlink', () => {
    const at = body.indexOf('const workableUnnamedLead = ');
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, at + 200)).toContain('!explicitUnlink');
  });
});
