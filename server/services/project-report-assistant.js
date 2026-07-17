/**
 * Project-report Waves AI — deterministic Q&A over a project report's own
 * payload (owner ask 2026-07-16: every report carries the Waves AI bar except
 * the WDO / pre-treatment paper documents). Mirrors the service report's
 * report-assistant approach: keyword routing + template answers built ONLY
 * from data already rendered on the page — no LLM, nothing new can leak.
 */

const { getProjectType, INTERNAL_FINDING_KEYS, redactInspectionFeeCues } = require('./project-types');

// Internal/office-only finding keys — never in an answer. Shared with the
// payload + narrative egress points via project-types (codex #2807).
const INTERNAL_FINDING_KEY_SET = new Set(INTERNAL_FINDING_KEYS);

const WAVES_PHONE_DISPLAY = '(941) 297-5749';

function cleanFindings(project) {
  let raw = project.findings;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  const findings = raw && typeof raw === 'object' ? raw : {};
  const entries = {};
  for (const [key, value] of Object.entries(findings)) {
    if (INTERNAL_FINDING_KEY_SET.has(key)) continue;
    const text = String(value ?? '').trim();
    if (text) entries[key] = text;
  }
  return entries;
}

function fieldLabel(typeCfg, key) {
  const field = (typeCfg?.fields || []).find((f) => f.key === key);
  if (field?.label) return field.label;
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function formatDateOnly(value) {
  if (!value) return '';
  const raw = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return '';
  return new Date(`${match[0]}T12:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function joinAnswer(lines) {
  return lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function answerFindings({ project, typeCfg }) {
  const findings = cleanFindings(project);
  const priority = ['findings_observed', 'pests_identified', 'wdo_finding', 'activity_status', 'severity', 'areas_inspected', 'areas_treated'];
  const picked = priority.filter((key) => findings[key]).slice(0, 3);
  if (!picked.length) {
    const any = Object.keys(findings).slice(0, 3);
    if (!any.length) return 'The full findings are listed on this report above.';
    return joinAnswer(any.map((key) => `${fieldLabel(typeCfg, key)}: ${findings[key]}.`));
  }
  return joinAnswer(picked.map((key) => `${fieldLabel(typeCfg, key)}: ${findings[key]}.`));
}

function answerTreatment({ project, typeCfg }) {
  const findings = cleanFindings(project);
  const keys = ['areas_treated', 'treatment_method', 'products_used', 'product_name', 'target_termite', 'linear_feet_or_stations', 'gallons_or_amount'];
  const picked = keys.filter((key) => findings[key]).slice(0, 4);
  if (!picked.length) return 'The treatment details for this project are listed on the report above.';
  return joinAnswer(picked.map((key) => `${fieldLabel(typeCfg, key)}: ${findings[key]}.`));
}

function answerNextVisit({ project, payload }) {
  const upcoming = payload?.upcomingAppointment || null;
  if (upcoming?.scheduledDate) {
    const date = formatDateOnly(upcoming.scheduledDate);
    return date
      ? `Your next visit is scheduled for ${date}.`
      : 'Your next visit is on the schedule — the date is shown on this report.';
  }
  if (payload?.followupCompletedAt) {
    return 'The follow-up visit for this project is already complete — details are on this report.';
  }
  const followupDate = formatDateOnly(project.followup_date || payload?.followupDate);
  if (followupDate) return `A follow-up is planned for ${followupDate}.`;
  return `Nothing further is scheduled for this project right now. Call or text ${WAVES_PHONE_DISPLAY} if you would like to set something up.`;
}

function answerRecommendations({ project }) {
  // same inspection-fee guard as the /data egress (codex #2817)
  const rec = redactInspectionFeeCues(String(project.recommendations || '')).trim();
  if (rec) {
    // Narrative drafts use WHAT WE RECOMMEND sections — answer with that
    // section when present, else the first two sentences.
    const section = /WHAT WE RECOMMEND\s*\n+([^\n]+)/i.exec(rec);
    if (section) return section[1].trim();
    const sentences = rec.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    if (sentences && !/^WHAT WE/i.test(sentences)) return sentences;
  }
  const findings = cleanFindings(project);
  if (findings.customer_recommendations) return findings.customer_recommendations;
  if (findings.treatment_recommendation) return findings.treatment_recommendation;
  if (findings.followup_plan) return `Our plan from here: ${findings.followup_plan}.`;
  return 'No extra steps were flagged for you on this report.';
}

function answerProjectReportQuestion({ question, project, payload }) {
  const q = String(question || '').toLowerCase();
  const typeCfg = getProjectType(project.project_type);

  if (/\b(next|follow|when|appointment|visit|schedule|come back)\b/.test(q)) {
    return answerNextVisit({ project, payload });
  }
  if (/\b(treat|product|use|used|appl|chemical|spray|bait|gallon)\b/.test(q)) {
    return answerTreatment({ project, typeCfg });
  }
  if (/\b(recommend|next step|advice|prep|do now|should i)\b/.test(q)) {
    return answerRecommendations({ project });
  }
  if (/\b(find|found|finding|see|saw|observe|activity|evidence|result)\b/.test(q)) {
    return answerFindings({ project, typeCfg });
  }
  return `The full details of this project are on the report above. For anything it doesn't cover, call or text ${WAVES_PHONE_DISPLAY} and we'll walk through it with you.`;
}

// Suggested prompt chips, mirrored client-side. Kept here so the answer
// router and the suggestions never drift apart.
function projectReportAskPrompts(project = {}) {
  return [
    'What did you find?',
    'What was treated?',
    'What should I do next?',
    'When is my next visit?',
  ];
}

module.exports = {
  answerProjectReportQuestion,
  projectReportAskPrompts,
  cleanFindings,
};
