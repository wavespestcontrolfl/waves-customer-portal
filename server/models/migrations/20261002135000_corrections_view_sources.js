/**
 * `corrections` view, fifth cut (Codex r4 on #5575; the fourth file is pushed
 * and so frozen). Same columns in the same order; two sources widen and the
 * outbound lookup gets its indexes:
 *   agent_decisions  a reply a person sends INSTEAD of a pending suggestion
 *                    links the suggestion through sms_log.metadata
 *                    .parked_decision_ids (the decision then reads ignored),
 *                    not agent_decision_id; human_text now follows either link.
 *   reply_training_examples  the Agent Review page's Reply training controls
 *                    write edited / rejected / no_reply_needed with the AI
 *                    draft, the person's reply, the reviewer and the time to
 *                    this table only (the decision's human_verdict is not
 *                    set): a sixth source, shown unless the linked decision
 *                    independently records a correction (then that row is the
 *                    one correction). version and model are unknown here.
 * Two partial indexes make the per-decision outbound lookup an index probe
 * instead of a scan of sms_log per correction: an expression index on the
 * decision stamp with the newest-first order, and a GIN on the parked array.
 * Plain indexes (house precedent: migrations run inside a transaction); both
 * are partial, so they cover only stamped rows. down drops the view, restores
 * the fourth cut and drops the indexes.
 */
const previous = require('./20261002130000_corrections_view_human_text');

const VIEW = 'corrections';
const DECISION_INDEX = 'sms_log_agent_decision_id_idx';
const PARKED_INDEX = 'sms_log_parked_decision_ids_idx';

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
         d.reviewed_at AS corrected_at
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
         r.labeled_at
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
         m.approved_at
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
         j.judged_at
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
         p.reviewed_at
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
         t.reviewed_at
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
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${DECISION_INDEX} ON sms_log ((metadata ->> 'agent_decision_id'), created_at DESC) WHERE metadata ->> 'agent_decision_id' IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${PARKED_INDEX} ON sms_log USING gin ((metadata -> 'parked_decision_ids') jsonb_path_ops) WHERE metadata -> 'parked_decision_ids' IS NOT NULL`);
  await knex.raw(SQL);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await previous.up(knex);
  await knex.raw(`DROP INDEX IF EXISTS ${PARKED_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${DECISION_INDEX}`);
};

exports.VIEW = VIEW;
exports.DECISION_INDEX = DECISION_INDEX;
exports.PARKED_INDEX = PARKED_INDEX;
