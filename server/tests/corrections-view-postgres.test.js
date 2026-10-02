/**
 * The `corrections` view (migrations 20261002100000 + 20261002110000 + 20261002120000) on a real PostgreSQL:
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
      corrected: randomUUID(), ignored: randomUUID(), dismissed: randomUUID(), accepted: randomUUID(), linkedCorrected: randomUUID(),
      labelWrong: randomUUID(), labelRight: randomUUID(),
      revised: randomUUID(), rejectedByPerson: randomUUID(), rejectedBySystem: randomUUID(), rejectedByGuard: randomUUID(), revisedArray: randomUUID(), rejectedArrayNoTag: randomUUID(), approved: randomUUID(), shadowDraft: randomUUID(), shadowDraft2: randomUUID(), shadowDraft3: randomUUID(),
      humanBetter: randomUUID(), equivalent: randomUUID(), humanBetterAlreadyCorrected: randomUUID(),
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
    await trx('message_drafts').insert([ids.revised, ids.rejectedByPerson, ids.rejectedBySystem, ids.rejectedByGuard, ids.revisedArray, ids.rejectedArrayNoTag, ids.approved, ids.shadowDraft, ids.shadowDraft2, ids.shadowDraft3].map(draft));
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
    const judgment = (id, verdict, draftId) => ({
      id, draft_id: draftId, intent: 'general', verdict, human_replied: true, human_reply_text: 'Yes, Tuesday works. See you then.',
      scores: JSON.stringify({ accuracy: 5 }), notes: 'Human answered the question', model: 'claude-opus-5-5', prompt_version: 'judge_v3', judged_at: at(5),
    });
    await trx('shadow_draft_judgments').insert([
      judgment(ids.humanBetter, 'human_better', ids.shadowDraft),
      judgment(ids.equivalent, 'equivalent', ids.shadowDraft2),
      judgment(ids.humanBetterAlreadyCorrected, 'human_better', ids.shadowDraft3),
    ]);
    // The judged draft's Agent Review decision was corrected by a person: one correction, shown as the decision.
    await trx('agent_decisions').insert(decision(ids.linkedCorrected, 'corrected', { entity_type: 'message_draft', entity_id: ids.shadowDraft3, correction_note: 'Agent Review draft edited and sent from SMS inbox.', reviewed_at: at(4.5) }));

    const profile = (id, status, version) => ({
      id, version, profile_text: `Profile ${id.slice(0, 4)}`, status, model: 'claude-opus-5-5', schema_version: 'v2',
      reviewed_by: status === 'rejected' ? 'owner@test' : null, reviewed_at: status === 'rejected' ? at(4) : null,
    });
    await trx('voice_profiles').insert([profile(ids.profileRejected, 'rejected', 900001), profile(ids.profilePending, 'pending', 900002)]);

    const rows = await trx('corrections').whereIn('source_id', Object.values(ids)).orderBy('corrected_at', 'asc');
    const byId = Object.fromEntries(rows.map((r) => [r.source_id, r]));

    expect(rows.map((r) => `${r.source}:${r.kind}`)).toEqual([
      'agent_decision:dismissed', 'agent_decision:corrected', 'agent_decision:ignored', 'typed_review:label_wrong',
      'message_draft:revised', 'message_draft:revised', 'message_draft:rejected', 'shadow_judgment:human_better', 'agent_decision:corrected', 'voice_profile:profile_rejected',
    ]);
    expect(byId[ids.linkedCorrected]).toMatchObject({ source: 'agent_decision', kind: 'corrected' });
    for (const absent of [ids.accepted, ids.labelRight, ids.rejectedBySystem, ids.rejectedByGuard, ids.rejectedArrayNoTag, ids.approved, ids.shadowDraft, ids.shadowDraft2, ids.shadowDraft3, ids.equivalent, ids.humanBetterAlreadyCorrected, ids.profilePending]) {
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
      version: 'house_voice_v12_real_answers3_cfl', model: 'gpt-5.6-terra', corrected_by: null,
    });
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
});
