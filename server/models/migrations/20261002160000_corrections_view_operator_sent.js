/**
 * `corrections` view, eleventh cut (Codex r8 on the tenth; that file is
 * pushed and so frozen). Same columns in the same order. A linked send counts
 * as the person's reply only by PERSISTED OPERATOR PROVENANCE, the same test
 * services/staff-contact.js operatorSentSql applies (owner ruling 2026-09-28):
 * the composer's metadata.human_authored stamp or a sending admin_user_id.
 * The tenth cut excluded one AI message type ('ai_autosent'); the gratitude
 * lane's 'ai_gratitude' sends (and any later autonomous type) slipped past a
 * type blacklist, and recovery re-stamps their parked siblings 'Admin'.
 * Reply comparison stays canonical (CANON, unchanged from the tenth cut).
 * down restores the tenth cut.
 */
const previous = require('./20261002150000_corrections_view_canonical_reply');

// Frozen copy of gsm-normalize REPLACEMENTS (2026-10-02): mapped characters,
// then the ones it deletes (translate drops characters past the target list).
const MAPPED = [
  ['\u2018', "'"], ['\u2019', "'"], ['\u201A', "'"], ['\u201B', "'"], ['\u2032', "'"], ['\u02BC', "'"], ['`', "'"], ['\u00B4', "'"],
  ['\u201C', '"'], ['\u201D', '"'], ['\u201E', '"'], ['\u201F', '"'], ['\u2033', '"'],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'], ['\u2015', '-'], ['\u2212', '-'], ['\u2022', '-'],
];
const DELETED = ['\u200B', '\u2060', '\uFEFF', '\u00AD'];
const SPACES = '\u00A0\u2000-\u200A\u202F\u205F\u3000';
const sqlString = (v) => `'${v.replace(/'/g, "''")}'`;
const FROM = MAPPED.map(([c]) => c).join('') + DELETED.join('');
const TO = MAPPED.map(([, r]) => r).join('');
const SPACE_CHARS = SPACES.replace(/\\u([0-9A-F]{4})-\\u([0-9A-F]{4})/g, (_m, a, b) => {
  let out = '';
  for (let c = parseInt(a, 16); c <= parseInt(b, 16); c += 1) out += String.fromCharCode(c);
  return out;
}).replace(/\\u([0-9A-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
const CANON = (expr) => `BTRIM(regexp_replace(replace(translate(COALESCE(${expr}, ''), ${sqlString(FROM)}, ${sqlString(TO)}), ${sqlString('\u2026')}, '...'), ${sqlString(`[[:space:]${SPACE_CHARS}]+`)}, ' ', 'g'))`;

const VIEW = 'corrections';

const SQL = `
CREATE OR REPLACE VIEW ${VIEW} AS
WITH linked_send AS (
  SELECT d.id AS decision_id,
         s.message_body, s.admin_user_id, s.created_at
    FROM agent_decisions d
    JOIN LATERAL (
      SELECT s.message_body, s.admin_user_id, s.created_at FROM sms_log s
       WHERE (s.metadata ->> 'agent_decision_id' = d.id::text
              OR s.metadata -> 'parked_decision_ids' @> to_jsonb(ARRAY[d.id::text]))
         AND s.direction = 'outbound'
         AND (COALESCE(s.metadata ->> 'human_authored', '') = 'true' OR s.admin_user_id IS NOT NULL)
         AND TRIM(COALESCE(s.message_body, '')) <> ''
       ORDER BY s.created_at DESC
       LIMIT 1
    ) s ON TRUE
   WHERE d.human_verdict IN ('corrected', 'ignored', 'dismissed')
),
counted_decision AS (
  SELECT d.*
    FROM agent_decisions d
   WHERE d.human_verdict IN ('corrected', 'dismissed')
      OR (d.human_verdict = 'ignored'
          AND d.reviewed_by IS DISTINCT FROM 'auto'
          AND EXISTS (SELECT 1 FROM linked_send ls WHERE ls.decision_id = d.id))
),
decision_reply AS (
  SELECT d.id AS decision_id,
         COALESCE(ls.message_body, j.human_reply_text) AS reply_text,
         CASE WHEN ls.decision_id IS NOT NULL THEN ls.admin_user_id ELSE js.admin_user_id END AS reply_by,
         CASE WHEN ls.decision_id IS NOT NULL THEN ls.created_at ELSE js.created_at END AS reply_at
    FROM counted_decision d
    LEFT JOIN linked_send ls ON ls.decision_id = d.id
    LEFT JOIN LATERAL (
      SELECT j.human_reply_text, j.human_reply_sms_id FROM shadow_draft_judgments j
       WHERE d.entity_type = 'message_draft'
         AND j.draft_id = d.entity_id
         AND TRIM(COALESCE(j.human_reply_text, '')) <> ''
       LIMIT 1
    ) j ON ls.decision_id IS NULL
    LEFT JOIN sms_log js ON js.id = j.human_reply_sms_id
)
  SELECT 'agent_decision'::text AS source,
         d.id AS source_id,
         d.human_verdict::text AS kind,
         'sms'::text AS surface,
         d.detected_intent::text AS topic,
         d.customer_id,
         d.suggested_message::text AS ai_text,
         COALESCE(dr.reply_text, d.correction_note)::text AS human_text,
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
         COALESCE(dr.reply_by::text, d.reviewed_by)::text AS corrected_by,
         COALESCE(dr.reply_at, d.reviewed_at) AS corrected_at
    FROM counted_decision d
    JOIN decision_reply dr ON dr.decision_id = d.id
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
           'judged_at', j.judged_at,
           'judge_model', j.model,
           'judge_prompt_version', j.prompt_version
         ),
         m.prompt_version::text,
         m.model::text,
         hs.admin_user_id::text,
         COALESCE(hs.created_at, j.judged_at)
    FROM shadow_draft_judgments j
    LEFT JOIN message_drafts m ON m.id = j.draft_id
    LEFT JOIN sms_log hs ON hs.id = j.human_reply_sms_id
   WHERE j.verdict IN ('human_better', 'draft_unsafe')
     AND NOT EXISTS (
       SELECT 1 FROM counted_decision cd
        WHERE cd.entity_type = 'message_draft'
          AND cd.entity_id = j.draft_id
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
         src.prompt_version::text,
         src.model::text,
         t.reviewed_by::text,
         t.reviewed_at
    FROM reply_training_examples t
    LEFT JOIN agent_decisions src ON src.id = t.source_agent_decision_id
   WHERE t.review_verdict IN ('edited', 'rejected', 'no_reply_needed')
     AND t.reviewed_by IS NOT NULL
     AND TRIM(COALESCE(t.agent_draft, '')) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM decision_reply dr
        WHERE dr.decision_id = t.source_agent_decision_id
          AND ${CANON('dr.reply_text')} <> ''
          AND ${CANON('dr.reply_text')} = ${CANON('t.outbound_body')}
     )
     AND NOT EXISTS (
       SELECT 1 FROM shadow_draft_judgments sj
        WHERE src.entity_type = 'message_draft'
          AND sj.draft_id = src.entity_id
          AND sj.verdict IN ('human_better', 'draft_unsafe')
          AND NOT EXISTS (SELECT 1 FROM counted_decision cd WHERE cd.id = src.id)
          AND ${CANON('sj.human_reply_text')} <> ''
          AND ${CANON('sj.human_reply_text')} = ${CANON('t.outbound_body')}
     )
`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await previous.up(knex);
};

exports.VIEW = VIEW;
exports.CANON = CANON;
