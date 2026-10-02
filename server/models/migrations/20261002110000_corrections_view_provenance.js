/**
 * `corrections` view, second cut (Codex r1 on #5575; the first file is pushed
 * and so frozen). Same columns in the same order, so CREATE OR REPLACE keeps
 * every reader; three rules change and one branch widens:
 *   message_drafts   a revised or rejected draft counts only when the review
 *                    endpoint itself wrote it: PUT /:id/revise and /:id/reject
 *                    stamp flags.review_verdict with the status they set, and
 *                    the view requires that stamp to match the row's status.
 *                    The campaign send guard and the Agent Ops duplicate sweep
 *                    also write status rejected with approved_by, and those
 *                    are not corrections; a draft released back to pending
 *                    after a revise keeps a stale stamp that no longer matches.
 *                    Drafts reviewed before the stamp existed are not shown.
 *   shadow_draft_judgments  a judged draft whose Agent Review decision a
 *                    person already corrected, ignored or dismissed is one
 *                    correction, shown as that decision; the judgment is
 *                    left out (the judge scores exactly that human send).
 *   decision_reviews detail carries subject_hash and package_hash, so a
 *                    reader can tell a label from a later reprocessed call or
 *                    a changed package apart, as the fixture exporter does.
 *   agent_decisions  human_verdict dismissed (the Agent Review page's "no")
 *                    joins corrected and ignored.
 * down restores the first cut.
 */
const previous = require('./20261002100000_corrections_view');

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
         d.correction_note::text AS human_text,
         jsonb_build_object(
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
     AND m.flags ->> 'review_verdict' = m.status
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
`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await previous.up(knex);
};

exports.VIEW = VIEW;
