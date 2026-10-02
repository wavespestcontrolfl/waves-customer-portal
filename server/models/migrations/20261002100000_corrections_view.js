/**
 * `corrections`: one read-only VIEW over every place a person already
 * corrects an AI decision at Waves (AI acceleration scope idea D, owner
 * 2026-10-01). No new writers and no new columns; the weekly corrections lane
 * (idea C) reads this instead of five tables.
 *
 * One row per correction, newest first when ordered by corrected_at:
 *   source / source_id   the table and row it came from
 *   kind                 what the person did there (see each branch)
 *   surface              sms | typed | voice
 *   topic                intent, capability or profile
 *   customer_id          when the source row carries one
 *   ai_text / human_text what the model produced / what the person put instead
 *                        (a note, an edited reply, the human's own reply)
 *   detail               the source's structured extras (corrected actions,
 *                        the right typed answer, judge scores, draft flags)
 *   version / model      the prompt or package version and model that produced
 *                        the AI text (for a judged draft: the DRAFTER's, not
 *                        the judge's, which rides in detail)
 *   corrected_by / corrected_at
 *
 * Branches:
 *   agent_decisions   human_verdict corrected (the staff reply differed from
 *                     the suggestion) or ignored (no staff action, or staff
 *                     replied without it; correction_note says which).
 *   decision_reviews  label_status confirmed_error: a reviewer marked the
 *                     typed answer wrong (label.correct_value is the right one).
 *   message_drafts    status revised or rejected BY A PERSON (approved_by set;
 *                     system retirements leave it null).
 *   shadow_draft_judgments  verdict human_better or draft_unsafe: the person's
 *                     own reply beat the shadow draft, or the draft was unsafe.
 *   voice_profiles    status rejected: a distilled voice profile turned down.
 *
 * The view carries customer message text exactly as the underlying tables do;
 * it is for in-database reads by staff tooling, never for export. Nothing
 * reads it yet; a one-tap reason on the review surfaces is the next PR.
 */
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
   WHERE d.human_verdict IN ('corrected', 'ignored')
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
};

exports.VIEW = VIEW;
