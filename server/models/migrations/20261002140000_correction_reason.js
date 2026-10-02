/**
 * One-tap correction reason (AI acceleration scope idea D, PR 2). Adds
 * agent_decisions.correction_reason (nullable, closed CHECK: the five reasons
 * in server/services/correction-reasons.js, pinned by test) and restates the
 * `corrections` view (sixth cut; the earlier files are frozen once pushed)
 * with one trailing column, `reason`: the decision's correction_reason, or
 * the typed label's `reason`, NULL for the other four sources. CREATE OR REPLACE
 * may append a column, so every reader of the earlier cuts keeps working.
 * down drops the view, restores the fifth cut and drops the column.
 */
const previous = require('./20261002135000_corrections_view_sources');

const TABLE = 'agent_decisions';
const COLUMN = 'correction_reason';
const CHECK = 'agent_decisions_correction_reason_check';
// Literal on purpose: a migration never follows a live constant.
const REASONS = ['wrong_fact', 'wrong_tone', 'missing_promise', 'should_have_escalated', 'other'];
const VIEW = 'corrections';

const SQL = `
CREATE OR REPLACE VIEW ${VIEW} AS
  SELECT 'agent_decision'::text AS source,
         d.id AS source_id,
         d.human_verdict::text AS kind,
         'sms'::text AS surface,
         d.detected_intent::text AS topic,
         d.customer_id,
         d.suggested_message::text AS ai_text,
         COALESCE(
           (SELECT s.message_body FROM sms_log s
             WHERE (s.metadata ->> 'agent_decision_id' = d.id::text
                    OR s.metadata -> 'parked_decision_ids' @> to_jsonb(ARRAY[d.id::text]))
               AND s.direction = 'outbound'
               AND TRIM(COALESCE(s.message_body, '')) <> ''
             ORDER BY s.created_at DESC
             LIMIT 1),
           (SELECT j.human_reply_text FROM shadow_draft_judgments j
             WHERE d.entity_type = 'message_draft'
               AND j.draft_id = d.entity_id
               AND TRIM(COALESCE(j.human_reply_text, '')) <> ''
             LIMIT 1),
           d.correction_note
         )::text AS human_text,
         jsonb_build_object(
           'correction_note', d.correction_note,
           'workflow', d.workflow,
           'decision_version', d.decision_version,
           'status', d.status,
           'recommended_actions', d.recommended_actions,
           'corrected_actions', d.corrected_actions,
           'sms_log_id', d.sms_log_id
         ) AS detail,
         d.prompt_version::text AS version,
         d.model::text AS model,
         d.reviewed_by::text AS corrected_by,
         d.reviewed_at AS corrected_at,
         d.correction_reason::text AS reason
    FROM agent_decisions d
   WHERE d.human_verdict IN ('corrected', 'ignored', 'dismissed')
UNION ALL
  SELECT 'typed_review'::text,
         r.id,
         'label_wrong'::text,
         'typed'::text,
         r.capability::text,
         NULL::uuid,
         r.jev_answer::text,
         (r.label ->> 'note')::text,
         jsonb_build_object(
           'package_id', r.package_id,
           'question_id', r.question_id,
           'correct_value', r.label -> 'correct_value',
           'subject_type', r.subject_type,
           'subject_id', r.subject_id,
           'subject_hash', r.subject_hash,
           'package_hash', r.package_hash,
           'sampled_for', r.sampled_for
         ),
         r.package_id::text,
         r.served_model::text,
         r.labeled_by::text,
         r.labeled_at,
         (r.label ->> 'reason')::text
    FROM decision_reviews r
   WHERE r.label_status = 'confirmed_error'
UNION ALL
  SELECT 'message_draft'::text,
         m.id,
         m.status::text,
         'sms'::text,
         m.intent::text,
         m.customer_id,
         m.draft_response::text,
         m.revised_response::text,
         jsonb_build_object(
           'sms_log_id', m.sms_log_id,
           'purpose', m.purpose,
           'campaign_type', m.campaign_type,
           'intended_actions', m.intended_actions,
           'flags', m.flags
         ),
         m.prompt_version::text,
         m.model::text,
         m.approved_by::text,
         m.approved_at,
         NULL::text
    FROM message_drafts m
   WHERE m.status IN ('revised', 'rejected')
     AND m.approved_by IS NOT NULL
     AND (
       (jsonb_typeof(m.flags) = 'object' AND m.flags ->> 'review_verdict' = m.status)
       OR (jsonb_typeof(m.flags) = 'array' AND m.flags @> to_jsonb(ARRAY['review_verdict:' || m.status]))
     )
UNION ALL
  SELECT 'shadow_judgment'::text,
         j.id,
         j.verdict::text,
         'sms'::text,
         j.intent::text,
         j.customer_id,
         m.draft_response::text,
         j.human_reply_text::text,
         jsonb_build_object(
           'draft_id', j.draft_id,
           'human_reply_sms_id', j.human_reply_sms_id,
           'scores', j.scores,
           'notes', j.notes,
           'judge_model', j.model,
           'judge_prompt_version', j.prompt_version
         ),
         m.prompt_version::text,
         m.model::text,
         NULL::text,
         j.judged_at,
         NULL::text
    FROM shadow_draft_judgments j
    LEFT JOIN message_drafts m ON m.id = j.draft_id
   WHERE j.verdict IN ('human_better', 'draft_unsafe')
     AND NOT EXISTS (
       SELECT 1 FROM agent_decisions ad
        WHERE ad.entity_type = 'message_draft'
          AND ad.entity_id = j.draft_id
          AND ad.human_verdict IN ('corrected', 'ignored', 'dismissed')
     )
UNION ALL
  SELECT 'voice_profile'::text,
         p.id,
         'profile_rejected'::text,
         'voice'::text,
         'voice_profile'::text,
         NULL::uuid,
         p.profile_text::text,
         NULL::text,
         jsonb_build_object(
           'version', p.version,
           'source_stats', p.source_stats
         ),
         p.schema_version::text,
         p.model::text,
         p.reviewed_by::text,
         p.reviewed_at,
         NULL::text
    FROM voice_profiles p
   WHERE p.status = 'rejected'
UNION ALL
  SELECT 'reply_training'::text,
         t.id,
         t.review_verdict::text,
         'sms'::text,
         t.scenario_label::text,
         t.customer_id,
         t.agent_draft::text,
         t.outbound_body::text,
         jsonb_build_object(
           'source_agent_decision_id', t.source_agent_decision_id,
           'review_note', t.review_note,
           'edit_summary', t.edit_summary,
           'capture_reason', t.capture_reason,
           'inbound_message_id', t.inbound_message_id,
           'outbound_message_id', t.outbound_message_id
         ),
         NULL::text,
         NULL::text,
         t.reviewed_by::text,
         t.reviewed_at,
         NULL::text
    FROM reply_training_examples t
   WHERE t.review_verdict IN ('edited', 'rejected', 'no_reply_needed')
     AND t.reviewed_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM agent_decisions ad
        WHERE ad.id = t.source_agent_decision_id
          AND ad.human_verdict IN ('corrected', 'ignored', 'dismissed')
     )
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COLUMN, 32); });
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (${COLUMN} IS NULL OR ${COLUMN} IN (${REASONS.map((r) => `'${r}'`).join(', ')}))`);
  await knex.raw(SQL);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await previous.up(knex);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};

exports.REASONS = REASONS;
exports.SQL = SQL;
exports.VIEW = VIEW;
