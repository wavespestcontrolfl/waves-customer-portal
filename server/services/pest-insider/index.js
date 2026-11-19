/**
 * Pest Insider issue builder: plan -> write -> check -> render.
 *
 * Content core only. Nothing here sends, schedules or touches the database;
 * the caller supplies recent picks and the optional blocks (blog link, area
 * line, tool, per-recipient home block). Returns { ok, reason, issue, diagnostics }
 * where `issue` is { subject, preview, html_body, text_body } when ok.
 */
'use strict';

const { planIssue } = require('./plan');
const { writeIssue } = require('./writer');
const { checkClaims } = require('./claim-check');
const { renderIssue, toolAllowed } = require('./render');
const { sendDateET } = require('./facts');

const SERVICE_EMOJI = { pest: '🐜', lawn: '🌱', tree_shrub: '🌴', mosquito: '🦟', termite: '🪵', rodent: '🐀' };

function claimFailReason(checked) {
  const why = checked.lead.length < 2 ? `only ${checked.lead.length} lead sentence(s) passed` : `id_item failed: ${checked.idItem.reason}`;
  return `claim_check_failed: ${why}`;
}

/**
 * @param {{ sendDate: string|Date, recent?: { factIds?: string[], speciesSlugs?: string[] },
 *   blogUrl?: string|null, areaLine?: string|null, tool?: object|null, home?: object|null,
 *   write?: Function, plan?: Function }} input   `write` is the writer and `plan` the
 *   planner (both injectable for tests).
 */
async function buildIssue({ sendDate, recent = {}, blogUrl = null, areaLine = null, tool = null, home = null, write = writeIssue, plan = planIssue }) {
  const dateET = sendDateET(sendDate);
  const diagnostics = { sendDate: dateET, factId: null, speciesSlug: null, cut: [], fallbacks: [], provider: null, model: null };

  const { leadFact, idItem, reason } = plan({
    sendDate: dateET,
    recentFactIds: recent.factIds || [],
    recentSpeciesSlugs: recent.speciesSlugs || [],
  });
  diagnostics.factId = leadFact ? leadFact.id : null;
  diagnostics.speciesSlug = idItem ? idItem.slug : null;
  if (!leadFact || !idItem) return { ok: false, reason, issue: null, diagnostics };

  const written = await write({ sendDate: dateET, leadFact, idItem });
  if (!written.ok) return { ok: false, reason: `writer_failed:${written.reason}`, issue: null, diagnostics };
  diagnostics.provider = written.provider || null;
  diagnostics.model = written.model || null;

  const checked = checkClaims({ draft: written.draft, leadFact, idItem });
  diagnostics.cut = checked.cut;
  diagnostics.fallbacks = checked.fallbacks;
  diagnostics.idItem = checked.idItem;
  if (!checked.ok) return { ok: false, reason: claimFailReason(checked), issue: null, diagnostics };

  if (tool && !toolAllowed(tool)) diagnostics.fallbacks.push('tool_dropped_affiliate');
  const issue = renderChecked({ checked, leadFact, idItem, blocks: { blogUrl, areaLine, tool, home } });
  return { ok: true, reason: null, issue, diagnostics };
}

// A failing subject or preview was already dropped by the claim check; the
// stand-ins are the fact's reviewed title and the species name.
function renderChecked({ checked, leadFact, idItem, blocks }) {
  return renderIssue({
    subject: checked.subject || `${SERVICE_EMOJI[leadFact.service]} ${leadFact.title}`,
    preview: checked.preview || `What's this? ${idItem.name}`,
    lead: { headline: checked.headline, sentences: checked.lead },
    idItem: { text: checked.idItem.text, species: idItem },
    ...blocks,
  });
}

module.exports = { buildIssue };
