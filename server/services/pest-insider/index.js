/**
 * Pest Insider issue builder: plan -> copy check -> render -> send-gate check.
 *
 * Content core only. Nothing here sends, schedules, calls a model or touches
 * the database; the caller supplies recent picks and the optional blocks (blog
 * link, area line, tool, per-recipient home block). Every word of the lead
 * and of "What's this?" is fixed, reviewed copy: the fact bank's `lead`
 * sentences and title, and the identifier species entry's fact. A fact
 * marked recheck_before_send leads only when the caller names it in
 * `recheckedFactIds` (a person re-read its source for this send).
 * Returns { ok, reason, issue, diagnostics } where `issue` is
 * { subject, preview, html_body, text_body } when ok.
 */
'use strict';

const { planIssue } = require('./plan');
const { checkIssueCopy } = require('./claim-check');
const { renderIssue, droppedBlocks } = require('./render');
const { sendDateET } = require('./facts');
const { validateNewsletterDraft } = require('../newsletter-validator');

// The Pest Insider's newsletter type key: the send path, the proof kill
// switch and the validator's claim rules all key on it.
const NEWSLETTER_TYPE = 'pest-insider-monthly';

const copyFailReason = (copy) => `copy_check_failed: ${copy.problems.map((p) => `${p.part}: ${p.reason}`).join('; ')}`;

// The send validator itself, on the issue as rendered. It reads the whole
// email, where a pronoun opening one block reads the sentence before it, so
// an issue this returns errors for would be refused at send anyway.
function sendGateErrors(issue) {
  const { errors } = validateNewsletterDraft({
    subject: issue.subject,
    preview_text: issue.preview,
    html_body: issue.html_body,
    text_body: issue.text_body,
    newsletter_type: NEWSLETTER_TYPE,
  });
  return errors;
}

/**
 * @param {{ sendDate: string|Date, recent?: { factIds?: string[], speciesSlugs?: string[] },
 *   recheckedFactIds?: string[], blogUrl?: string|null, areaLine?: string|null, tool?: object|null,
 *   home?: object|null, plan?: Function }} input   `plan` is the planner (injectable for tests).
 */
function buildIssue({ sendDate, recent = {}, recheckedFactIds = [], blogUrl, areaLine, tool, home, plan = planIssue }) {
  const dateET = sendDateET(sendDate);
  const diagnostics = { sendDate: dateET, factId: null, speciesSlug: null, problems: [], fallbacks: [] };

  const { leadFact, idItem, reason } = plan({
    sendDate: dateET,
    recentFactIds: recent.factIds || [],
    recentSpeciesSlugs: recent.speciesSlugs || [],
    recheckedFactIds,
  });
  diagnostics.factId = leadFact ? leadFact.id : null;
  diagnostics.speciesSlug = idItem ? idItem.slug : null;
  if (!leadFact || !idItem) return { ok: false, reason, issue: null, diagnostics };
  if (leadFact.recheck_before_send && !recheckedFactIds.includes(leadFact.id)) {
    return { ok: false, reason: `recheck_needed: ${leadFact.id}`, issue: null, diagnostics };
  }

  const copy = checkIssueCopy({ leadFact, species: idItem });
  diagnostics.problems = copy.problems;
  if (!copy.ok) return { ok: false, reason: copyFailReason(copy), issue: null, diagnostics };

  diagnostics.fallbacks.push(...droppedBlocks({ areaLine, tool, home }));
  const issue = renderIssue({
    subject: copy.subject,
    preview: copy.preview,
    lead: { headline: copy.headline, sentences: copy.lead.map((text) => ({ text })) },
    idItem: { text: copy.idText, species: idItem },
    blogUrl,
    areaLine,
    tool,
    home,
  });

  const errors = sendGateErrors(issue);
  if (errors.length) {
    diagnostics.problems = errors.map((err) => ({ part: 'send_validator', text: '', reason: err }));
    return { ok: false, reason: `send_validator_blocked: ${errors[0]}`, issue: null, diagnostics };
  }
  return { ok: true, reason: null, issue, diagnostics };
}

module.exports = { buildIssue, NEWSLETTER_TYPE };
