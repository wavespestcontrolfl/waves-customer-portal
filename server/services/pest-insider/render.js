/**
 * Pest Insider renderer: a checked issue -> { subject, preview, html_body, text_body }.
 *
 * html_body is the BODY only, the same shape the old Pest Insider stores in
 * newsletter_sends.html_body (assemblePestInsiderNewsletter): wrapNewsletter
 * adds the Waves chrome and unsubscribe footer at send time. It carries the
 * dm-* hooks the dark-mode stylesheet keys on, so bodyIsDarkAware() is true.
 *
 * The body is one email for every subscriber, and the public archive serves
 * it as stored. So it holds only reviewed copy (the fact's lead and title,
 * the species entry) and links the renderer builds itself from a species
 * slug, or takes from the reviewed post list (posts.js: the lead's "Read the
 * full story on our blog" link must be one of POST_URLS). It takes no other
 * caller text and no other caller link: every round of the pre-push audit
 * (5 to 10) found another way such input could carry a code, a name, an
 * email or a merge tag into a shared email. The other blocks are added per
 * recipient, never to the shared body: "A tool we'd use" (withToolBlock,
 * opted-in readers only: its Amazon link may reach neither the archive nor
 * a reader who never opted in), and in PR 4 "Active near you" from area
 * counts and "Your home".
 *
 * No line asks the reader to forward the email: a forwarded copy carries
 * the subscriber's own unsubscribe link, and its page shows their address
 * (pre-push round 11). The plan's referral line comes in PR 4, linked to the
 * issue's web page (the send's archive link).
 *
 * Every piece of text is escaped.
 */
'use strict';

const { newsletterPalette, newsletterSectionTheme, wrapNewsletter, bodyIsDarkAware } = require('../email-template');
const { SITE, POST_URLS } = require('./posts');
const { toolById, toolLinkText, AMAZON_DISCLOSURE } = require('./tools');

const IDENTIFIER_URL = `${SITE}/pest-identifier/`;
const POST_LINK_TEXT = 'Read the full story on our blog';

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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

function leadBlock({ lead }) {
  // Every issue links the lead fact's post, and only a reviewed post URL.
  if (!POST_URLS.includes(lead.postUrl)) throw new Error('pest-insider render: the lead link must be a reviewed post URL (posts.js)');
  const body = lead.sentences.map((s) => s.text).join(' ');
  const html = [
    headingHtml(0, 'Today I learned'),
    `<h3 class="dm-ink" style="margin:0 0 8px 0;font-size:17px;line-height:1.4;">${escapeHtml(lead.headline)}</h3>`,
    paragraph(escapeHtml(body)),
    paragraph(link(lead.postUrl, POST_LINK_TEXT)),
  ].join('\n');
  const text = ['TODAY I LEARNED', lead.headline, '', body, '', `${POST_LINK_TEXT}: ${lead.postUrl}`].join('\n');
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

// "A tool we'd use": the reviewed tool's lines and link, and Amazon's exact
// sentence right after the link, in both parts. Every word comes from the
// tool list; the caller passes only the product id.
function toolBlock(toolId) {
  const tool = toolById(toolId);
  if (!tool) throw new Error('pest-insider render: the tool must be a reviewed tool (tools.js)');
  const about = tool.lines.join(' ');
  const html = [
    headingHtml(2, "A tool we'd use"),
    paragraph(escapeHtml(about)),
    paragraph(link(tool.url, toolLinkText(tool))),
    paragraph(escapeHtml(AMAZON_DISCLOSURE)),
  ].join('\n');
  const text = ["A TOOL WE'D USE", about, '', `${toolLinkText(tool)}: ${tool.url}`, AMAZON_DISCLOSURE].join('\n');
  return { html, text };
}

const wrapBlock = (b) => `<div class="dm-text">\n${b.html}\n</div>`;

/**
 * @param {{ subject: string, preview: string,
 *   lead: { headline: string, sentences: {text:string}[], postUrl: string },
 *   idItem: { text: string, species: { slug: string, name: string } } }} issue
 *   lead.postUrl must be one of the reviewed POST_URLS. Any other field is
 *   ignored: the shared body takes no caller text.
 */
function renderIssue(issue) {
  const blocks = [leadBlock(issue), identifierBlock(issue)];
  const html = blocks.map(wrapBlock).join('\n');
  const text = blocks.map((b) => b.text).join('\n\n');
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

/**
 * The issue as an opted-in reader gets it: the shared issue with "A tool
 * we'd use" after "What's this?". Owner 2026-11-19: Amazon links go only to
 * readers who opted in, so the shared issue (renderIssue), which the archive
 * serves to anyone, never has the tool. The send path (PR 4) adds it per
 * recipient, only for a reader with opt-in evidence, and checks that body
 * before it sends.
 * @param {{ subject: string, preview: string, html_body: string, text_body: string }} issue  renderIssue's result
 * @param {string} toolId  a reviewed tool's product id (tools.js)
 */
function withToolBlock(issue, toolId) {
  const block = toolBlock(toolId);
  return { ...issue, html_body: `${issue.html_body}\n${wrapBlock(block)}`, text_body: `${issue.text_body}\n${block.text}\n` };
}

module.exports = { renderIssue, withToolBlock, wrapIssueHtml, escapeHtml, IDENTIFIER_URL, POST_LINK_TEXT };
