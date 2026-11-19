/**
 * Pest Insider renderer: a checked issue -> { subject, preview, html_body, text_body }.
 *
 * html_body is the BODY only, the same shape the old Pest Insider stores in
 * newsletter_sends.html_body (assemblePestInsiderNewsletter): wrapNewsletter
 * adds the Waves chrome and unsubscribe footer at send time. It carries the
 * dm-* hooks the dark-mode stylesheet keys on, so bodyIsDarkAware() is true.
 *
 * Every piece of text is escaped. Links are absolute https URLs on
 * www.wavespestcontrol.com (a blogUrl or tool url that is not https, that
 * carries a {{...}} merge tag, or a blog link off that host, is dropped); the
 * tool link is the one allowed off-site https link.
 *
 * The body is one email for every subscriber, and the public archive serves
 * it as stored, so it holds no household's details. "Your home" (a
 * customer's own visits) is rendered per recipient at delivery, in PR 4
 * (pre-push round 8).
 */
'use strict';

const { newsletterPalette, newsletterSectionTheme, wrapNewsletter, bodyIsDarkAware } = require('../email-template');
const { containsAffiliateMaterial } = require('../content/content-guardrails');

const SITE = 'https://www.wavespestcontrol.com';
const IDENTIFIER_URL = `${SITE}/pest-identifier/`;
const FORWARD_LINE = 'Know a neighbor with a pest problem? Forward this email.';

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The sender fills {{...}} merge tags per recipient, in both parts
// (newsletter-draft.js), so caller text or a link that carries one could put
// a subscriber's own value, such as an unsubscribe link, into the copy or
// into a link to another site (pre-push round 8). Such input is left out.
const MERGE_TAG = /\{\{|\}\}|%7b%7b|%7d%7d/i;

function httpsUrl(url, { host } = {}) {
  if (MERGE_TAG.test(String(url))) return null;
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || (host && u.hostname !== host)) return null;
    return u.toString();
  } catch { return null; }
}

const siteUrl = (url) => httpsUrl(url, { host: 'www.wavespestcontrol.com' });
const speciesUrl = (slug) => (/^[a-z0-9-]+$/.test(String(slug)) ? `${IDENTIFIER_URL}${slug}/` : null);

function headingHtml(index, label) {
  const palette = newsletterPalette();
  const theme = newsletterSectionTheme(index);
  return `<h2 class="dm-chip" style="font-family:${palette.font};font-size:20px;line-height:1.35;font-weight:800;color:${theme.text};background:${theme.background};border-left:4px solid ${theme.accent};border-radius:8px;padding:10px 12px;margin:0 0 10px 0;">${escapeHtml(label)}</h2>`;
}

const paragraph = (html) => `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${html}</p>`;
const link = (href, label) => `<a class="dm-link" href="${escapeHtml(href)}" style="color:${newsletterPalette().blue};text-decoration:underline;font-weight:600;">${escapeHtml(label)}</a>`;
const box = (inner) => `<div class="dm-box" style="margin:0 0 14px 0;padding:14px 18px;background:${newsletterPalette().cardBg};border-radius:10px;font-size:15px;line-height:1.6;">${inner}</div>`;
const small = (html) => `<p class="dm-muted" style="margin:0 0 14px 0;font-size:14px;line-height:1.5;color:${newsletterPalette().muted};">${html}</p>`;

// Each block returns { html, text } or null (omitted cleanly).
function leadBlock({ lead, blogUrl }) {
  const body = lead.sentences.map((s) => s.text).join(' ');
  const url = siteUrl(blogUrl);
  const html = [
    headingHtml(0, 'Today I learned'),
    `<h3 class="dm-ink" style="margin:0 0 8px 0;font-size:17px;line-height:1.4;">${escapeHtml(lead.headline)}</h3>`,
    paragraph(escapeHtml(body)),
    url ? paragraph(link(url, 'Read the full story')) : '',
  ].join('\n');
  const text = ['TODAY I LEARNED', lead.headline, '', body, ...(url ? ['', `Read the full story: ${url}`] : [])].join('\n');
  return { html, text };
}

function identifierBlock({ idItem }) {
  const page = speciesUrl(idItem.species.slug);
  const html = [
    headingHtml(1, "What's this?"),
    box(`<strong>${escapeHtml(idItem.species.name)}</strong><br/>${escapeHtml(idItem.text)}${page ? `<br/>${link(page, `See the ${idItem.species.name} page`)}` : ''}`),
    small(`Not sure what you are looking at? ${link(IDENTIFIER_URL, 'Send us a photo for a free ID')}.`),
  ].join('\n');
  const text = [
    "WHAT'S THIS?", idItem.species.name, idItem.text,
    ...(page ? [`${idItem.species.name} page: ${page}`] : []),
    '', `Not sure what you are looking at? Send us a photo for a free ID: ${IDENTIFIER_URL}`,
  ].join('\n');
  return { html, text };
}

// Caller-supplied text (the area line, a tool's words) is not reviewed copy,
// so before it renders it must pass every check, and text that fails one is
// left out (pre-push rounds 5 to 9):
// - the checks the reviewed copy passes (claim-check bannedReason: banned
//   words, pesticide and brand names, DIY ingredients, the tripwires and the
//   shared fact register);
// - the complete customer-copy screen (AGENTS.md customerCopyViolations);
// - the content PII check (an email, a phone, a street address, a name);
// - no code-shaped number. The report screen lets a device name next to
//   digits pass, so that report prose like "120 linear feet around the
//   garage" stays legal; a forwardable mass email leaves out "Side gate
//   #1234", "gate 4417" and "1-2-3-4". One- and two-digit counts ("12 homes
//   near you") stay.
// The checks load heavier modules, so they are required only when such text
// is given.
const CODE_SHAPED_NUMBER = /#\s*\d|\d{3}|\b\d(?:[\s-]+\d){2,}\b/;

function screenedText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || CODE_SHAPED_NUMBER.test(text) || MERGE_TAG.test(text)) return '';
  const { bannedReason } = require('./claim-check');
  const { customerCopyViolations } = require('../service-report/technician-report-copy');
  const { redact } = require('../content/pii-redactor');
  if (bannedReason(text) || customerCopyViolations(text).length || redact(text).findings.length) return '';
  return text;
}

const given = (value) => value != null && String(value).trim() !== '';

function areaBlock({ areaLine }) {
  const line = screenedText(areaLine);
  if (!line) return null;
  return { html: [headingHtml(0, 'Active near you'), paragraph(escapeHtml(line))].join('\n'), text: `ACTIVE NEAR YOU\n${line}` };
}

// The newsletter send validator blocks affiliate material in every email
// (newsletter-validator.js, AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL), so a tool
// whose url or text carries any is left out here, never rendered into a draft
// the validator would then refuse. PR 3 owns the Amazon path.
function toolAllowed(tool) {
  if (!tool || typeof tool !== 'object') return false;
  return ![tool.url, tool.name, tool.why, tool.disclosure].some((v) => v && containsAffiliateMaterial(String(v)));
}

// tool: { name, why, url, disclosure? }; name, why and an https url are required.
const toolTextPasses = (tool) => [tool.name, tool.why, tool.disclosure].every((v) => !given(v) || screenedText(v));

function toolBlock({ tool }) {
  if (!toolAllowed(tool) || !toolTextPasses(tool)) return null;
  const url = httpsUrl(tool.url);
  const name = screenedText(tool.name);
  const why = screenedText(tool.why);
  if (!url || !name || !why) return null;
  const disclosure = screenedText(tool.disclosure);
  const html = [
    headingHtml(1, "A tool we'd use"),
    box(`<strong>${escapeHtml(name)}</strong><br/>${escapeHtml(why)}<br/>${link(url, `See ${name}`)}`),
    disclosure ? small(escapeHtml(disclosure)) : '',
  ].join('\n');
  const text = ["A TOOL WE'D USE", name, why, url, ...(disclosure ? ['', disclosure] : [])].join('\n');
  return { html, text };
}

// What renderIssue leaves out of the optional inputs a caller gave it, as
// fallback names for the build's diagnostics.
function droppedBlocks({ areaLine, tool }) {
  return [
    given(areaLine) && !screenedText(areaLine) && 'area_line_dropped',
    tool && !toolAllowed(tool) && 'tool_dropped_affiliate',
    tool && toolAllowed(tool) && !toolTextPasses(tool) && 'tool_dropped_copy',
  ].filter(Boolean);
}

/**
 * @param {{ subject: string, preview: string, lead: { headline: string, sentences: {text:string}[] },
 *   idItem: { text: string, species: { slug: string, name: string } },
 *   blogUrl?: string|null, areaLine?: string|null, tool?: object|null }} issue
 */
function renderIssue(issue) {
  const blocks = [leadBlock(issue), identifierBlock(issue), areaBlock(issue), toolBlock(issue)].filter(Boolean);
  const html = [
    ...blocks.map((b) => `<div class="dm-text">\n${b.html}\n</div>`),
    `<p class="dm-muted" style="margin:18px 0 0 0;font-size:14px;line-height:1.5;text-align:center;color:${newsletterPalette().muted};">${escapeHtml(FORWARD_LINE)}</p>`,
  ].join('\n');
  const text = [...blocks.map((b) => b.text), FORWARD_LINE].join('\n\n');
  return { subject: issue.subject, preview: issue.preview, html_body: html, text_body: `${text}\n` };
}

/**
 * The full email page: the body inside the newsletter chrome. wrapNewsletter
 * puts the preheader into the HTML as given, so it is escaped here; the
 * subject never enters the HTML.
 * @param {{ html_body: string, preview: string }} issue
 * @param {{ unsubscribeUrl: string }} opts
 */
function wrapIssueHtml(issue, { unsubscribeUrl }) {
  return wrapNewsletter({
    body: issue.html_body,
    unsubscribeUrl,
    preheader: escapeHtml(issue.preview),
    darkAwareBody: bodyIsDarkAware(issue.html_body),
  });
}

module.exports = { renderIssue, wrapIssueHtml, toolAllowed, droppedBlocks, escapeHtml, FORWARD_LINE, IDENTIFIER_URL };
