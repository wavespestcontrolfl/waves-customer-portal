/**
 * The small HTML pieces of a Waves Pest Insider issue's body that more than
 * one module writes: render.js (the issue) and referral-line.js (the referral
 * line, whose value every surface fills in at its time of use).
 *
 * This file loads no fact bank, picture or send check, so a module that every
 * newsletter surface loads (referral-line.js) can use it.
 */
const { newsletterPalette } = require('../email-template');

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const paragraph = (html) => `<p style="margin:0 0 14px 0;font-size:16px;line-height:1.6;">${html}</p>`;
const link = (href, label) => `<a class="dm-link" href="${escapeHtml(href)}" style="color:${newsletterPalette().blue};text-decoration:underline;font-weight:600;">${escapeHtml(label)}</a>`;
// One block of the body ({ html }) in the wrapper that follows dark mode.
const wrapBlock = (b) => `<div class="dm-text">\n${b.html}\n</div>`;

module.exports = { escapeHtml, paragraph, link, wrapBlock };
