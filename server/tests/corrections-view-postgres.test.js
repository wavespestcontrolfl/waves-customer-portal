/**
 * The `corrections` view (migrations 20261002100000 through 20261002138000) on a real PostgreSQL:
 * one row per human correction across its five sources, the AI text beside
 * what the person put instead, and nothing for rows that are not corrections
 * (an accepted suggestion, a right typed answer, a draft the system retired,
 * a judge verdict that did not prefer the person, a profile still pending).
 *
 * Runs only with DATABASE_URL (CI's migrated database); every row is written
 * inside one transaction that is rolled back, so nothing persists.
 */
const { randomUUID, randomBytes } = require('node:crypto');

// CI's DB-gated step selects suites by this exact line.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('corrections view (PostgreSQL)', () => {
  let database;
  let trx;
  const at = (minutesAgo) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - minutesAgo * 60000);

  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    trx = await database.transaction();
  });
  afterAll(async () => { await trx?.rollback(); await database?.destroy(); });

  test('one row per correction across the five sources, with the AI text and the human text side by side; non-corrections stay out', async () => {
    const ids = {
      corrected: randomUUID(), ignored: randomUUID(), dismissed: randomUUID(), accepted: randomUUID(), linkedCorrected: randomUUID(), linkedCorrectedNoSend: randomUUID(), settlingSend: randomUUID(), parkedSend: randomUUID(), trainingEdited: randomUUID(), trainingOnCorrected: randomUUID(), trainingSameReply: randomUUID(), trainingMatchesJudgment: randomUUID(), trainingDecision: randomUUID(), humanReplySms: randomUUID(),
      labelWrong: randomUUID(), labelRight: randomUUID(),
      revised: randomUUID(), rejectedByPerson: randomUUID(), rejectedBySystem: randomUUID(), rejectedByGuard: randomUUID(), revisedArray: randomUUID(), rejectedArrayNoTag: randomUUID(), approved: randomUUID(), shadowDraft: randomUUID(), shadowDraft2: randomUUID(), shadowDraft3: randomUUID(), shadowDraft4: randomUUID(),
      humanBetter: randomUUID(), equivalent: randomUUID(), humanBetterAlreadyCorrected: randomUUID(), humanBetterNoSend: randomUUID(),
      profileRejected: randomUUID(), profilePending: randomUUID(),
    };
    const reviewer = randomUUID();
    await trx('technicians').insert({ id: reviewer, name: 'Test Reviewer' });

    const decision = (id, human_verdict, extra = {}) => ({
      id, workflow: 'sms_suggest', agent_name: 'sms-suggest', decision_version: 'v1', status: human_verdict,
      detected_intent: 'reschedule', suggested_message: `Suggested ${id.slice(0, 4)}`, prompt_version: 'house_voice_v12_real_answers3_cfl',
      model: 'claude-sonnet-5-5', human_verdict, reviewed_by: 'office@test', reviewed_at: at(10), ...extra,
    });
    await trx('agent_decisions').insert([
      decision(ids.corrected, 'corrected', { correction_note: 'Reviewed draft edited, scheduled, and sent from the SMS inbox.', corrected_actions: JSON.stringify([{ type: 'reply' }]) }),
      decision(ids.ignored, 'ignored', { correction_note: 'A staff reply to this thread was sent.', reviewed_at: at(9.9) }), // distinct times keep the order deterministic
      decision(ids.dismissed, 'dismissed', { correction_note: 'Not needed.', reviewed_at: at(10.5) }),
      decision(ids.accepted, 'accepted', { correction_note: 'Reviewed draft scheduled and sent from the SMS inbox.' }),
    ]);

    const review = (id, label_status, label) => ({
      id, capability: 'sms_courtesy', package_id: 'sms_courtesy.v1', package_hash: randomBytes(32).toString('hex'), served_model: 'jev-1.13.0',
      subject_type: 'sms_log', subject_id: randomUUID(), question_id: 'is_courtesy_only', jev_answer: JSON.stringify({ p: 0.91, yes: true, confident: true }),
      sampled_for: 'random_audit', subject_hash: randomBytes(32).toString('hex'), label: JSON.stringify(label), label_status, labeled_by: 'reviewer@test', labeled_at: at(9),
    });
    await trx('decision_reviews').insert([
      review(ids.labelWrong, 'confirmed_error', { verdict: 'jev_wrong', correct_value: false, note: 'They asked to move the visit' }),
      review(ids.labelRight, 'confirmed_correct', { verdict: 'jev_right', correct_value: null, note: null }),
    ]);

    // Drafts are born as house-voice shadow rows (the insert trigger admits
    // nothing else while legacy AI drafts are off) and move to their reviewed
    // status by update, exactly as the suggest and review paths do.
    const draft = (id) => ({
      id, status: 'shadow', drafter: 'house_voice', intent: 'general', draft_response: `Draft ${id.slice(0, 4)}`,
      prompt_version: 'house_voice_v12_real_answers3_cfl', model: 'gpt-5.6-terra',
    });
    await trx('message_drafts').insert([ids.revised, ids.rejectedByPerson, ids.rejectedBySystem, ids.rejectedByGuard, ids.revisedArray, ids.rejectedArrayNoTag, ids.approved, ids.shadowDraft, ids.shadowDraft2, ids.shadowDraft3, ids.shadowDraft4].map(draft));
    // The review endpoints stamp flags.review_verdict with the status they set (migration 20261002110000 requires it).
    await trx('message_drafts').where({ id: ids.revised }).update({ status: 'revised', revised_response: 'We can come Tuesday at 2 PM.', approved_by: reviewer, approved_at: at(8), flags: JSON.stringify({ review_verdict: 'revised' }) });
    await trx('message_drafts').where({ id: ids.rejectedByPerson }).update({ status: 'rejected', approved_by: reviewer, approved_at: at(7), flags: JSON.stringify({ review_verdict: 'rejected' }) });
    // The house-voice drafter stores flags as an ARRAY of tags; the endpoints append a 'review_verdict:<status>' tag there.
    await trx('message_drafts').where({ id: ids.revisedArray }).update({ status: 'revised', revised_response: 'Tuesday at 2 works.', approved_by: reviewer, approved_at: at(7.8), flags: JSON.stringify(['needs_review', 'review_verdict:revised']) });
    await trx('message_drafts').where({ id: ids.rejectedArrayNoTag }).update({ status: 'rejected', approved_by: reviewer, approved_at: at(7.6), flags: JSON.stringify(['needs_review']) });
    // The campaign send guard writes rejected + approved_by without the stamp: not a correction.
    await trx('message_drafts').where({ id: ids.rejectedByGuard }).update({ status: 'rejected', approved_by: reviewer, approved_at: at(7.5), flags: JSON.stringify({ campaign_rejected_reason: 'cooldown' }) });
    await trx('message_drafts').where({ id: ids.rejectedBySystem }).update({ status: 'rejected', flags: JSON.stringify({ campaign_rejected_reason: 'answered' }) });
    await trx('message_drafts').where({ id: ids.approved }).update({ status: 'approved', approved_by: reviewer, approved_at: at(6) });

    // One judgment per draft (unique on draft_id), so each verdict gets its own shadow draft.
    // The person's own reply the judge graded: its sender and time are the correction's provenance.
    await trx('sms_log').insert({
      id: ids.humanReplySms, direction: 'outbound', from_phone: '+19415550190', to_phone: '+19415550100', message_type: 'manual', status: 'delivered',
      message_body: 'Yes, Tuesday works. See you then.', admin_user_id: reviewer, created_at: at(5.5),
    });
    const judgment = (id, verdict, draftId) => ({
      id, draft_id: draftId, intent: 'general', verdict, human_replied: true, human_reply_text: 'Yes, Tuesday works. See you then.',
      scores: JSON.stringify({ accuracy: 5 }), notes: 'Human answered the question', model: 'claude-opus-5-5', prompt_version: 'judge_v3', judged_at: at(5),
    });
    await trx('shadow_draft_judgments').insert([
      { ...judgment(ids.humanBetter, 'human_better', ids.shadowDraft), human_reply_sms_id: ids.humanReplySms },
      judgment(ids.equivalent, 'equivalent', ids.shadowDraft2),
      judgment(ids.humanBetterAlreadyCorrected, 'human_better', ids.shadowDraft3),
      judgment(ids.humanBetterNoSend, 'human_better', ids.shadowDraft4),
    ]);
    // The judged draft's Agent Review decision was corrected by a person: one correction, shown as the decision.
    await trx('agent_decisions').insert([
      decision(ids.linkedCorrected, 'corrected', { entity_type: 'message_draft', entity_id: ids.shadowDraft3, correction_note: 'Agent Review draft edited and sent from SMS inbox.', reviewed_at: at(4.5) }),
      // corrected, judged, but its settling send is not on record: the judgment's human text stands in
      decision(ids.linkedCorrectedNoSend, 'corrected', { entity_type: 'message_draft', entity_id: ids.shadowDraft4, correction_note: 'Agent Review draft edited and sent from SMS inbox.', reviewed_at: at(4.4) }),
    ]);
    // A reply sent INSTEAD of a pending suggestion links it through metadata.parked_decision_ids (the decision reads ignored).
    await trx('sms_log').insert({
      id: ids.parkedSend, direction: 'outbound', from_phone: '+19415550190', to_phone: '+19415550100', message_type: 'manual', status: 'delivered',
      message_body: 'We will be there Thursday morning.', metadata: JSON.stringify({ parked_decision_ids: [ids.ignored] }), created_at: at(9.8),
    });
    // What the person actually sent: the outbound text stamped with the decision id (the send that settled it).
    await trx('sms_log').insert({
      id: ids.settlingSend, direction: 'outbound', from_phone: '+19415550190', to_phone: '+19415550100', message_type: 'manual', status: 'delivered',
      message_body: 'Tuesday at 2 is fine. See you then.', metadata: JSON.stringify({ agent_decision_id: ids.linkedCorrected }), created_at: at(4.6),
    });

    const profile = (id, status, version) => ({
      id, version, profile_text: `Profile ${id.slice(0, 4)}`, status, model: 'claude-opus-5-5', schema_version: 'v2',
      reviewed_by: status === 'rejected' ? 'owner@test' : null, reviewed_at: status === 'rejected' ? at(4) : null,
    });
    await trx('voice_profiles').insert([profile(ids.profileRejected, 'rejected', 900001), profile(ids.profilePending, 'pending', 900002)]);

    // Reply training: the Agent Review page's reply controls write here only (the decision's human_verdict stays unset).
    await trx('agent_decisions').insert(decision(ids.trainingDecision, null, { human_verdict: null, status: 'pending_review', reviewed_by: null, reviewed_at: null }));
    const training = (id, source, verdict, reviewed_at) => ({
      id, channel: 'sms', source_agent_decision_id: source, inbound_body: 'Can you come Thursday?', outbound_body: 'Thursday at 9 works, see you then.', agent_draft: `Draft ${id.slice(0, 4)}`,
      agent_draft_edited: true, scenario_label: 'scheduling', capture_reason: 'agent_review_reply_verdict', status: 'reviewed', review_verdict: verdict,
      review_note: 'Named the day', reviewed_by: 'office@test', reviewed_at, captured_at: reviewed_at,
    });
    await trx('reply_training_examples').insert([
      training(ids.trainingEdited, ids.trainingDecision, 'edited', at(3.5)),
      // its decision was corrected too, but shows a DIFFERENT reply (the settling send): a separate rewrite, kept
      training(ids.trainingOnCorrected, ids.linkedCorrected, 'edited', at(3.4)),
      // its decision already shows this same reply as its human text: one correction, left out
      { ...training(ids.trainingSameReply, ids.linkedCorrected, 'edited', at(3.3)), outbound_body: '  Tuesday at 2 is fine. See you then. ' },
      // matches the decision's JUDGMENT text, but the decision row displays its newer settling send: this text is nowhere else, so it stays
      { ...training(ids.trainingMatchesJudgment, ids.linkedCorrected, 'edited', at(3.2)), outbound_body: 'Yes, Tuesday works. See you then.' },
    ]);
    const rows = await trx('corrections').whereIn('source_id', Object.values(ids)).orderBy('corrected_at', 'asc');
    const byId = Object.fromEntries(rows.map((r) => [r.source_id, r]));

    expect(rows.map((r) => `${r.source}:${r.kind}`)).toEqual([
      'agent_decision:dismissed', 'agent_decision:corrected', 'agent_decision:ignored', 'typed_review:label_wrong',
      'message_draft:revised', 'message_draft:revised', 'message_draft:rejected', 'shadow_judgment:human_better', 'agent_decision:corrected', 'agent_decision:corrected', 'voice_profile:profile_rejected', 'reply_training:edited', 'reply_training:edited', 'reply_training:edited',
    ]);
    // the person's own text, not the canned note: the settling send first, the judgment's human text when no send is on record, the note last
    expect(byId[ids.linkedCorrected]).toMatchObject({ source: 'agent_decision', kind: 'corrected', human_text: 'Tuesday at 2 is fine. See you then.' });
    expect(byId[ids.linkedCorrected].detail.correction_note).toBe('Agent Review draft edited and sent from SMS inbox.');
    expect(byId[ids.linkedCorrectedNoSend]).toMatchObject({ kind: 'corrected', human_text: 'Yes, Tuesday works. See you then.' });
    // a reply sent instead of the suggestion reaches the ignored decision through the parked link
    expect(byId[ids.ignored]).toMatchObject({ kind: 'ignored', human_text: 'We will be there Thursday morning.' });
    expect(byId[ids.ignored].detail.correction_note).toBe('A staff reply to this thread was sent.');
    // reply training: the draft beside the person's reply, the verdict as the kind, no version or model known
    expect(byId[ids.trainingEdited]).toMatchObject({ source: 'reply_training', kind: 'edited', surface: 'sms', topic: 'scheduling', ai_text: `Draft ${ids.trainingEdited.slice(0, 4)}`, human_text: 'Thursday at 9 works, see you then.', version: 'house_voice_v12_real_answers3_cfl', model: 'claude-sonnet-5-5', corrected_by: 'office@test' });
    // a rewrite saved beside a separately corrected decision is its own correction
    expect(byId[ids.trainingOnCorrected]).toMatchObject({ source: 'reply_training', kind: 'edited', human_text: 'Thursday at 9 works, see you then.' });
    // the dedup compares against the reply the decision row DISPLAYS (its newest send), not any linked text
    expect(byId[ids.linkedCorrected].human_text).toBe('Tuesday at 2 is fine. See you then.');
    expect(byId[ids.trainingMatchesJudgment]).toMatchObject({ source: 'reply_training', human_text: 'Yes, Tuesday works. See you then.' });
    expect(byId[ids.trainingEdited].detail).toMatchObject({ source_agent_decision_id: ids.trainingDecision, review_note: 'Named the day', capture_reason: 'agent_review_reply_verdict' });
    for (const absent of [ids.accepted, ids.labelRight, ids.rejectedBySystem, ids.rejectedByGuard, ids.rejectedArrayNoTag, ids.approved, ids.shadowDraft, ids.shadowDraft2, ids.shadowDraft3, ids.shadowDraft4, ids.equivalent, ids.humanBetterAlreadyCorrected, ids.humanBetterNoSend, ids.profilePending, ids.trainingSameReply, ids.trainingDecision]) {
      expect(byId[absent]).toBeUndefined();
    }
    expect(Object.keys(rows[0]).sort()).toEqual(['ai_text', 'corrected_at', 'corrected_by', 'customer_id', 'detail', 'human_text', 'kind', 'model', 'source', 'source_id', 'surface', 'topic', 'version']);

    expect(byId[ids.corrected]).toMatchObject({
      surface: 'sms', topic: 'reschedule', ai_text: `Suggested ${ids.corrected.slice(0, 4)}`, human_text: 'Reviewed draft edited, scheduled, and sent from the SMS inbox.',
      version: 'house_voice_v12_real_answers3_cfl', model: 'claude-sonnet-5-5', corrected_by: 'office@test',
    });
    expect(byId[ids.corrected].detail).toMatchObject({ workflow: 'sms_suggest', decision_version: 'v1', corrected_actions: [{ type: 'reply' }] });
    expect(byId[ids.corrected].corrected_at).toEqual(at(10));

    expect(byId[ids.labelWrong]).toMatchObject({ surface: 'typed', topic: 'sms_courtesy', human_text: 'They asked to move the visit', version: 'sms_courtesy.v1', model: 'jev-1.13.0', corrected_by: 'reviewer@test', customer_id: null });
    expect(JSON.parse(byId[ids.labelWrong].ai_text)).toEqual({ p: 0.91, yes: true, confident: true });
    expect(byId[ids.labelWrong].detail).toMatchObject({ package_id: 'sms_courtesy.v1', question_id: 'is_courtesy_only', correct_value: false, subject_type: 'sms_log', sampled_for: 'random_audit' });
    // provenance a reader needs before treating the label as evidence: the exact package and subject text it was given on
    expect(byId[ids.labelWrong].detail.package_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(byId[ids.labelWrong].detail.subject_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(byId[ids.revised]).toMatchObject({ surface: 'sms', topic: 'general', ai_text: `Draft ${ids.revised.slice(0, 4)}`, human_text: 'We can come Tuesday at 2 PM.', corrected_by: reviewer, model: 'gpt-5.6-terra' });
    expect(byId[ids.rejectedByPerson]).toMatchObject({ kind: 'rejected', human_text: null, corrected_by: reviewer });
    expect(byId[ids.revisedArray]).toMatchObject({ kind: 'revised', human_text: 'Tuesday at 2 works.' });
    expect(byId[ids.revisedArray].detail.flags).toEqual(['needs_review', 'review_verdict:revised']);

    expect(byId[ids.humanBetter]).toMatchObject({
      surface: 'sms', ai_text: `Draft ${ids.shadowDraft.slice(0, 4)}`, human_text: 'Yes, Tuesday works. See you then.',
      version: 'house_voice_v12_real_answers3_cfl', model: 'gpt-5.6-terra', corrected_by: reviewer,
    });
    // the person's reply time, not the nightly judge run; the judge time rides in detail
    expect(byId[ids.humanBetter].corrected_at).toEqual(at(5.5));
    expect(new Date(byId[ids.humanBetter].detail.judged_at)).toEqual(at(5));
    expect(byId[ids.humanBetter].detail).toMatchObject({ draft_id: ids.shadowDraft, judge_model: 'claude-opus-5-5', judge_prompt_version: 'judge_v3', scores: { accuracy: 5 }, notes: 'Human answered the question' });

    expect(byId[ids.profileRejected]).toMatchObject({ surface: 'voice', topic: 'voice_profile', ai_text: `Profile ${ids.profileRejected.slice(0, 4)}`, human_text: null, version: 'v2', corrected_by: 'owner@test' });
    expect(byId[ids.profileRejected].detail).toMatchObject({ version: 900001 });
  });

  test('the view is not granted to the read-only chart role: it carries customer message text', async () => {
    const { rows } = await trx.raw("SELECT rolname FROM pg_roles WHERE rolname LIKE '%readonly%'");
    for (const { rolname } of rows) {
      const { rows: [{ can }] } = await trx.raw('SELECT has_table_privilege(?, ?, ?) AS can', [rolname, 'corrections', 'SELECT']);
      expect({ rolname, can }).toEqual({ rolname, can: false });
    }
  });

  test('the outbound-decision lookup is indexed: a partial expression index on the decision stamp and a GIN on the parked array', async () => {
    const { rows } = await trx.raw("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sms_log' AND indexname IN ('sms_log_agent_decision_id_idx', 'sms_log_parked_decision_ids_idx') ORDER BY indexname");
    expect(rows.map((r) => r.indexname)).toEqual(['sms_log_agent_decision_id_idx', 'sms_log_parked_decision_ids_idx']);
    expect(rows[0].indexdef).toMatch(/\(\(metadata ->> 'agent_decision_id'::text\)\), created_at DESC\) WHERE \(\(metadata ->> 'agent_decision_id'::text\) IS NOT NULL\)/);
    expect(rows[1].indexdef).toMatch(/USING gin \(\(\(metadata -> 'parked_decision_ids'::text\)\) jsonb_path_ops\) WHERE \(\(metadata -> 'parked_decision_ids'::text\) IS NOT NULL\)/);
  });
});
