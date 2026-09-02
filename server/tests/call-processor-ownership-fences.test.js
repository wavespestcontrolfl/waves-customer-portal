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

  test('commitments are recorded after finalization, fenced on the pass generation, with the settled disposition', () => {
    const zeroTriageAt = body.indexOf('await applyZeroTriageLayers({');
    const commitmentsAt = body.indexOf("require('./call-commitments').recordCallCommitments({");
    expect(zeroTriageAt).toBeGreaterThan(-1);
    expect(commitmentsAt).toBeGreaterThan(zeroTriageAt);
    const callSite = body.slice(commitmentsAt, commitmentsAt + 700);
    expect(callSite).toContain('disposition: settled.disposition || null');
    expect(callSite).toContain('procGeneration,');
    expect(callSite).not.toContain('procToken');
  });

  test('the customer timeline entry is keyed on the call, not the pass', () => {
    const at = body.indexOf("await db('customer_interactions').insert({");
    expect(at).toBeGreaterThan(-1);
    const preceding = body.slice(Math.max(0, at - 700), at);
    expect(preceding).toContain("whereRaw(\"metadata ->> 'call_log_id' = ?\", [String(call.id)])");
    expect(preceding).toContain('if (!timelineExists) {');
    expect(body.slice(at, at + 600)).toContain('call_log_id: call.id');
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
