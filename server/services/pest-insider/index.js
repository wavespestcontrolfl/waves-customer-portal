/**
 * Pest Insider issue builder: plan -> copy check -> render -> send-gate check.
 *
 * Content core only. Nothing here sends, schedules, calls a model or touches
 * the database; the caller supplies the send date and recent picks. The
 * builder always plans with `planIssue`, which picks only an eligible fact
 * and an approved species, and takes no planner from the caller: a caller's
 * planner would supply both the copy and the evidence it is checked against
 * (pre-push round 17). Tests mock the plan module instead. Every
 * word of the lead and of "What's this?" is fixed, reviewed copy: the fact
 * bank's `lead` sentences and title, and the identifier species entry's
 * fact. A fact marked recheck_before_send leads only when the caller names
 * it in `recheckedFactIds` (a person re-read its source for this send).
 * Every issue links the lead fact's reviewed blog post (posts.js), so a fact
 * leads only when the caller names it in `livePostFactIds`: the facts whose
 * post answered as live for this send (posts.checkLivePosts). With no list,
 * no issue builds. "A tool we'd use" is a reviewed tool (tools.js) whose
 * link passed this send's live check (the caller names those links in
 * `liveToolUrls`). It is not in `issue`: the result's `tool` names it (its
 * productId and the checked link `url`), and the send path adds it per
 * recipient, for opted-in readers only (render.withToolBlock, which renders
 * it only while the tool's link is still the checked one), so the shared
 * body, which the archive serves, never carries an Amazon link. The send
 * path records one `recent.toolIds` entry per issue: the tool's product id,
 * or null for an issue without one.
 * Returns { ok, reason, issue, tool, diagnostics } where `issue` is
 * { subject, preview, html_body, text_body } and `tool` is the live tool or
 * null, when ok.
 */
'use strict';

const { planIssue } = require('./plan');
const { checkIssueCopy } = require('./claim-check');
const { renderIssue } = require('./render');
const { sendDateET } = require('./facts');
const { postUrl } = require('./posts');
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
 * @param {{ sendDate: string|Date, recent?: { factIds?: string[], speciesSlugs?: string[], toolIds?: (string|null)[] },
 *   recheckedFactIds?: string[], livePostFactIds?: string[], liveToolUrls?: string[] }} input
 *   The issue is one email for every subscriber and takes no caller text (render.js says why).
 */
function buildIssue({ sendDate, recent = {}, recheckedFactIds = [], livePostFactIds = [], liveToolUrls = [] }) {
  const dateET = sendDateET(sendDate);
  const diagnostics = { sendDate: dateET, factId: null, speciesSlug: null, toolId: null, problems: [] };

  const { leadFact, idItem, tool, reason } = planIssue({
    sendDate: dateET,
    recentFactIds: recent.factIds || [],
    recentSpeciesSlugs: recent.speciesSlugs || [],
    recheckedFactIds,
    livePostFactIds,
    liveToolUrls,
    recentToolIds: recent.toolIds || [],
  });
  const toolId = tool ? tool.productId : null;
  diagnostics.factId = leadFact ? leadFact.id : null;
  diagnostics.speciesSlug = idItem ? idItem.slug : null;
  diagnostics.toolId = toolId;
  if (!leadFact || !idItem) return { ok: false, reason, issue: null, diagnostics };
  if (leadFact.recheck_before_send && !recheckedFactIds.includes(leadFact.id)) {
    return { ok: false, reason: `recheck_needed: ${leadFact.id}`, issue: null, diagnostics };
  }
  // The planner leads only with a fact whose post is live; one it returns
  // anyway is refused, like a fact that still needs its recheck.
  const post = postUrl(leadFact.id);
  if (!post || !livePostFactIds.includes(leadFact.id)) {
    return { ok: false, reason: `no_live_post: ${leadFact.id}`, issue: null, diagnostics };
  }
  // The same for the tool: the planner picks only a tool whose link is live.
  if (tool && !liveToolUrls.includes(tool.url)) {
    return { ok: false, reason: `no_live_tool: ${toolId}`, issue: null, diagnostics };
  }

  const copy = checkIssueCopy({ leadFact, species: idItem });
  diagnostics.problems = copy.problems;
  if (!copy.ok) return { ok: false, reason: copyFailReason(copy), issue: null, diagnostics };

  const issue = renderIssue({
    subject: copy.subject,
    preview: copy.preview,
    lead: { headline: copy.headline, sentences: copy.lead.map((text) => ({ text })), postUrl: post },
    idItem: { text: copy.idText, species: idItem },
  });

  const errors = sendGateErrors(issue);
  if (errors.length) {
    diagnostics.problems = errors.map((err) => ({ part: 'send_validator', text: '', reason: err }));
    return { ok: false, reason: `send_validator_blocked: ${errors[0]}`, issue: null, diagnostics };
  }
  return { ok: true, reason: null, issue, tool, diagnostics };
}

module.exports = { buildIssue, NEWSLETTER_TYPE };
