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
 * full story on the Waves blog" link must be one of POST_URLS). It takes no other
 * caller text and no other caller link: every round of the pre-push audit
 * (5 to 10) found another way such input could carry a code, a name, an
 * email or a merge tag into a shared email. The other blocks are added per
 * recipient, never to the shared body: "A tool we'd use" (withToolBlock,
 * opted-in readers only: its Amazon link may reach neither the archive nor
 * a reader who never opted in), and in PR 4 "Active near you" from area
 * counts and "Your home". A per-reader block goes in before the sign-off
 * (addReaderBlock).
 *
 * The look follows the weekly newsletter (owner 2026-11-19: "boring, no
 * visuals, look at what we do for the local newsletter"; then "more
 * pictures ... use text in some of them, or facts, numbers"; Fable advised
 * on it in two rounds): a dateline, the lead fact's top picture (its title
 * in big letters beside ChatGPT art, heroes.js), a greeting, then each section as a small label over an emoji band that carries its
 * title (the fact's title, the species name, the tool name), the fact's
 * card (a drawn picture of its number or key phrase, cards.js), a fact box,
 * a species card with an emoji tile, the Waves badge between sections, a
 * gold button and a sign-off. Body text is 16px (customer design brief).
 * Every picture and link is reviewed data or a fixed asset: the top
 * picture, the card, source names and band emoji come by the lead's fact id,
 * the latin name and verdict from the species entry. No word inside
 * a reviewed sentence is restyled; a whole sentence may be. The fixed lines
 * below state no pest fact; the send check reads them with the rest. Every
 * mention of the newsletter, blog or website says Waves (owner 2026-11-19,
 * "make a rule").
 *
 * No line asks the reader to forward the email: a forwarded copy carries
 * the subscriber's own unsubscribe link, and its page shows their address
 * (pre-push round 11). The plan's referral line comes in PR 4, linked to the
 * issue's web page (the send's archive link).
 *
 * Every piece of text is escaped.
 */
'use strict';

const { newsletterPalette, newsletterSectionTheme, wrapNewsletter, bodyIsDarkAware, ctaButton } = require('../email-template');
const { SITE, POST_URLS, postUrl } = require('./posts');
const { factById } = require('./facts');
const { cardFor, sourceLine, CARD_WIDTH, CARD_HEIGHT } = require('./cards');
const { heroFor, HERO_WIDTH, HERO_HEIGHT } = require('./heroes');
const { SERVICE_EMOJI } = require('./claim-check');
const { toolById, toolLinkText, AMAZON_DISCLOSURE } = require('./tools');

const IDENTIFIER_URL = `${SITE}/pest-identifier/`;
const POST_LINK_TEXT = 'Read the full story on the Waves blog';
const PHOTO_ID_TEXT = 'Send us a photo for a free ID';

// The weekly newsletter's divider (newsletter-draft.js WAVES_DIVIDER_GIF):
// the Waves mascot badge on our own CDN. Not a link, so it is no stray tap
// target.
const DIVIDER_GIF = 'https://d2riygw2ap9mi.cloudfront.net/social-media/waves-divider-2026-v2.gif';

const GREETING = 'Hey there!';
const INTRO = "Here's one thing we learned about Southwest Florida homes and yards, plus one critter worth knowing.";
const SIGNOFF_LINE = 'Catch you next time.';
const SIGNOFF_NAME = '— The Waves Team';

const SECTIONS = Object.freeze({ lead: 'Today I learned', id: "What's this?", tool: "A tool we'd use" });
const LEAD_EMOJI = '💡';
const ID_EMOJI = '🔍';
const TOOL_EMOJI = '🧰';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The species card's tile: the species' own emoji where its category's would
// show another animal, else its category's, else the magnifier. "Biting"
// (bed bug, flea, tick) and "Wildlife neighbors" (a frog, lizards, a
// tortoise, an armadillo) have no one emoji that fits every member.
const CATEGORY_EMOJI = Object.freeze({
  Ants: '🐜',
  Lawn: '🌱',
  'Mosquitoes & biters': '🦟',
  'Occasional invaders': '🐛',
  'Plant pests': '🌿',
  Roaches: '🪳',
  Rodents: '🐀',
  Spiders: '🕷️',
  Stingers: '🐝',
  Termites: '🪵',
});
const SPECIES_EMOJI = Object.freeze({
  'house-mouse': '🐁',
  'no-see-um': '🪰',
  lovebug: '🪰',
  'drain-fly': '🪰',
  'fungus-gnat': '🪰',
  'puss-caterpillar': '🐛',
  'io-moth-caterpillar': '🐛',
  'cuban-treefrog': '🐸',
  'brown-anole': '🦎',
  gecko: '🦎',
  'gopher-tortoise': '🐢',
});
const DEFAULT_EMOJI = '🔍';

// The verdict chip: the website identifier's labels and colors (astro
// src/data/pestIdentifier.ts VERDICT_META, PestIdentifierTool.tsx), so the
// card says what the species page says; the catalog and the website agree on
// all 60 verdicts. A "harmless" species gets no chip: that label, and any
// short one for it, is an absolute safety claim, which the send check
// refuses in this email (newsletter-validator.js).
const VERDICTS = Object.freeze({
  ally: Object.freeze({ label: 'Helpful — leave it', background: '#D1FAE5', text: '#065F46' }),
  watch: Object.freeze({ label: 'Keep an eye on it', background: '#FEF3C7', text: '#92400E' }),
  call: Object.freeze({ label: 'Worth a pro look', background: '#FEF2F2', text: '#991B1B' }),
});

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const own = (map, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
const speciesUrl = (slug) => (/^[a-z0-9-]+$/.test(String(slug)) ? `${IDENTIFIER_URL}${slug}/` : null);

// A section's head: its name as a small label, then the newsletter's band
// (emoji, then the title in bold italics). The emoji sits on a white badge
// that stays white in dark mode (dm-lightcard), so a dark emoji (🕷️ 🐜 🪳)
// stays visible.
function sectionHead(index, label, emoji, title) {
  const palette = newsletterPalette();
  const theme = newsletterSectionTheme(index);
  return [
    `<p style="margin:0 0 6px 0;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${theme.text};">${escapeHtml(label)}</p>`,
    `<h2 class="dm-chip" style="font-family:${palette.font};font-size:20px;line-height:1.35;font-weight:800;color:${theme.text};background:${theme.background};border-left:4px solid ${theme.accent};border-radius:8px;padding:10px 12px;margin:0 0 14px 0;"><span class="dm-lightcard" style="display:inline-block;background:#FFFFFF;border-radius:8px;padding:2px 6px;line-height:1.25;font-style:normal;">${emoji}</span> <strong><em>${escapeHtml(title)}</em></strong></h2>`,
  ].join('\n');
}

const paragraph = (html) => `<p style="margin:0 0 14px 0;font-size:16px;line-height:1.6;">${html}</p>`;
const link = (href, label) => `<a class="dm-link" href="${escapeHtml(href)}" style="color:${newsletterPalette().blue};text-decoration:underline;font-weight:600;">${escapeHtml(label)}</a>`;
// The newsletter's event box: one emoji row per line.
const metaBox = (rows) => `<div class="dm-box" style="margin:0 0 14px 0;padding:12px 16px;background:${newsletterPalette().cardBg};border-radius:10px;font-size:15px;line-height:2;">\n${rows.join('<br/>\n')}\n</div>`;

const DIVIDER_HTML = `<div style="text-align:center;margin:28px 0;"><img src="${DIVIDER_GIF}" alt="" width="48" height="48" style="width:48px;height:48px;border:0;display:inline-block;" /></div>`;

const SIGNOFF_HTML = `<div class="dm-text">
<p style="margin:26px 0 4px 0;font-size:16px;line-height:1.6;"><strong>${escapeHtml(SIGNOFF_LINE)}</strong></p>
<p style="margin:0;font-size:16px;line-height:1.6;">${escapeHtml(SIGNOFF_NAME)} 🌊</p>
</div>`;
const SIGNOFF_TEXT = `${SIGNOFF_LINE}\n${SIGNOFF_NAME}\n`;

// The lead fact's top picture (heroes.js), linked to the post: the fact's
// title in big gold letters on a navy panel beside its art. A JPEG as wide
// as the column on a desktop screen (582px in wrapNewsletter's card), with
// its size in the tag, so every Outlook shows it. Its words are the fact's
// title, so it shows only over that headline.
function heroHtml(lead) {
  const fact = leadFact(lead);
  const hero = fact ? heroFor(fact.id) : null;
  if (!hero || lead.headline !== hero.title) return '';
  return `<div style="margin:0 0 18px 0;"><a href="${escapeHtml(lead.postUrl)}" style="text-decoration:none;"><img src="${escapeHtml(hero.url)}" alt="${escapeHtml(hero.alt)}" width="${HERO_WIDTH}" height="${HERO_HEIGHT}" style="width:100%;max-width:${HERO_WIDTH}px;height:auto;border:0;border-radius:12px;display:block;" /></a></div>`;
}

// About 220 words a minute, never under one.
const readMinutes = (text) => Math.max(1, Math.round(String(text).split(/\s+/).filter(Boolean).length / 220));

// "Waves Pest Insider · Dec 3, 2026 · 1-min read": the edition's name, its
// send date (a real YYYY-MM-DD, else left out) and the read time.
function datelineText(sendDate, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof sendDate === 'string' ? sendDate : '');
  const day = m ? Number(m[3]) : 0;
  const date = m && MONTHS[Number(m[2]) - 1] && day >= 1 && day <= 31 ? `${MONTHS[Number(m[2]) - 1]} ${day}, ${m[1]}` : '';
  return ['Waves Pest Insider', date, `${minutes}-min read`].filter(Boolean).join(' · ');
}

function openingBlock(issue, minutes) {
  const palette = newsletterPalette();
  const dateline = datelineText(issue.sendDate, minutes);
  const html = [
    `<p class="dm-muted" style="margin:0 0 14px 0;text-align:center;font-size:12px;line-height:1.5;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${palette.muted};">${escapeHtml(dateline)}</p>`,
    heroHtml(issue.lead),
    `<p style="margin:0 0 8px 0;font-size:22px;line-height:1.4;">👋 <strong><em>${escapeHtml(GREETING)}</em></strong></p>`,
    `<p style="margin:0 0 26px 0;font-size:16px;line-height:1.6;">${escapeHtml(INTRO)}</p>`,
  ].filter(Boolean).join('\n');
  return { html, text: `${dateline}\n\n${GREETING}\n${INTRO}` };
}

// The lead fact, when the lead names one whose own post is the lead's post.
function leadFact(lead) {
  const fact = typeof lead.factId === 'string' ? factById(lead.factId) : null;
  return fact && postUrl(fact.id) === lead.postUrl ? fact : null;
}

function leadBlock({ lead }) {
  // Every issue links the lead fact's post, and only a reviewed post URL.
  if (!POST_URLS.includes(lead.postUrl)) throw new Error('pest-insider render: the lead link must be a reviewed post URL (posts.js)');
  const sentences = lead.sentences.map((s) => s.text);
  const body = sentences.join(' ');
  const [first = '', ...rest] = sentences;
  const fact = leadFact(lead);
  const emoji = (fact && own(SERVICE_EMOJI, fact.service)) || LEAD_EMOJI;
  const source = sourceLine(fact);
  const card = fact ? cardFor(fact.id) : null;
  const html = [
    sectionHead(0, SECTIONS.lead, emoji, lead.headline),
    `<p class="dm-ink" style="margin:0 0 10px 0;font-size:17px;line-height:1.55;font-weight:600;">${escapeHtml(first)}</p>`,
    ...(rest.length ? [paragraph(escapeHtml(rest.join(' ')))] : []),
    // The fact's card, as a recap after its sentences (its words repeat the
    // title or a sentence, so it does not sit right under them). A PNG, so
    // every Outlook shows it; its alt text is its words.
    ...(card ? [`<div style="margin:4px 0 16px 0;"><img src="${escapeHtml(card.url)}" alt="${escapeHtml(card.alt)}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" style="width:100%;max-width:${CARD_WIDTH}px;height:auto;border:0;border-radius:12px;display:block;" /></div>`] : []),
    metaBox([
      ...(source ? [`📚 <em>${escapeHtml(source)}</em>`] : []),
      `🔗 ${link(lead.postUrl, POST_LINK_TEXT)}`,
    ]),
  ].join('\n');
  const text = ['TODAY I LEARNED', lead.headline, '', body, '', `${POST_LINK_TEXT}: ${lead.postUrl}`, ...(source ? [source] : [])].join('\n');
  return { html, text };
}

const speciesEmoji = (species) => own(SPECIES_EMOJI, species.slug) || own(CATEGORY_EMOJI, species.category) || DEFAULT_EMOJI;

// The species card: a white emoji tile beside the latin name and verdict
// chip, then the species' fact and its page link. The tile is text, so it
// shows with pictures off and in every Outlook.
function speciesCardHtml(species, factText, page) {
  const palette = newsletterPalette();
  const verdict = own(VERDICTS, species.verdict);
  const latin = typeof species.scientific === 'string' ? species.scientific.trim() : '';
  const tags = [
    ...(latin ? [`<em class="dm-muted" style="color:${palette.muted};">${escapeHtml(latin)}</em>`] : []),
    ...(verdict ? [`<span class="dm-chip-lite" style="display:inline-block;padding:4px 12px;border-radius:999px;background:${verdict.background};color:${verdict.text};font-size:13px;line-height:1.3;font-weight:700;font-style:normal;">${escapeHtml(verdict.label)}</span>`] : []),
  ];
  return [
    `<div class="dm-box" style="margin:0 0 16px 0;padding:14px 16px;background:${palette.cardBg};border-radius:12px;">`,
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 12px 0;"><tr>',
    `<td width="64" valign="middle" style="width:64px;padding:0 14px 0 0;vertical-align:middle;"><div class="dm-lightcard" style="width:64px;height:64px;line-height:64px;border-radius:14px;background:#FFFFFF;text-align:center;font-size:36px;">${speciesEmoji(species)}</div></td>`,
    `<td valign="middle" style="vertical-align:middle;font-size:15px;line-height:1.9;">${tags.join('<br/>\n')}</td>`,
    '</tr></table>',
    `<p style="margin:0 0 8px 0;font-size:16px;line-height:1.6;">${escapeHtml(factText)}</p>`,
    ...(page ? [`<p style="margin:0;font-size:15px;line-height:1.6;">🔗 ${link(page, `See the ${species.name} page on the Waves website`)}</p>`] : []),
    '</div>',
  ].join('\n');
}

function identifierBlock({ idItem }) {
  const { species } = idItem;
  const page = speciesUrl(species.slug);
  const verdict = own(VERDICTS, species.verdict);
  const latin = typeof species.scientific === 'string' ? species.scientific.trim() : '';
  const palette = newsletterPalette();
  const html = [
    sectionHead(1, SECTIONS.id, ID_EMOJI, species.name),
    speciesCardHtml(species, idItem.text, page),
    `<p class="dm-muted" style="margin:0 0 10px 0;text-align:center;font-size:15px;line-height:1.5;color:${palette.muted};">Not sure what you are looking at?</p>`,
    ctaButton(escapeHtml(IDENTIFIER_URL), `📸 ${escapeHtml(PHOTO_ID_TEXT)}`),
  ].join('\n');
  const text = [
    "WHAT'S THIS?", latin ? `${species.name} (${latin})` : species.name,
    ...(verdict ? [`Verdict: ${verdict.label}`] : []),
    idItem.text,
    ...(page ? [`${species.name} page on the Waves website: ${page}`] : []),
    '', `Not sure what you are looking at? ${PHOTO_ID_TEXT}: ${IDENTIFIER_URL}`,
  ].join('\n');
  return { html, text };
}

// "A tool we'd use": the reviewed tool's lines and link, and Amazon's exact
// sentence right after the link, in both parts. Every word comes from the
// tool list. Styling only here: Amazon's trademark rules allow no Amazon
// logo or Amazon-styled button in email, so the link stays plain text.
function toolBlock(tool) {
  const about = tool.lines.join(' ');
  const html = [
    sectionHead(2, SECTIONS.tool, TOOL_EMOJI, tool.name),
    paragraph(escapeHtml(about)),
    `<div class="dm-box" style="margin:0 0 14px 0;padding:12px 16px;background:${newsletterPalette().cardBg};border-radius:10px;">`,
    `<p style="margin:0 0 6px 0;font-size:16px;line-height:1.6;">🔗 ${link(tool.url, toolLinkText(tool))}</p>`,
    `<p style="margin:0;font-size:16px;line-height:1.6;">${escapeHtml(AMAZON_DISCLOSURE)}</p>`,
    '</div>',
  ].join('\n');
  const text = ["A TOOL WE'D USE", about, '', `${toolLinkText(tool)}: ${tool.url}`, AMAZON_DISCLOSURE].join('\n');
  return { html, text };
}

const wrapBlock = (b) => `<div class="dm-text">\n${b.html}\n</div>`;

/**
 * @param {{ subject: string, preview: string, sendDate?: string,
 *   lead: { headline: string, sentences: {text:string}[], postUrl: string, factId?: string },
 *   idItem: { text: string, species: { slug: string, name: string, category?: string,
 *     scientific?: string, verdict?: string } } }} issue
 *   lead.postUrl must be one of the reviewed POST_URLS. lead.factId names the
 *   fact whose top picture, card and sources the issue shows (only when that
 *   fact's own post is lead.postUrl) and whose service picks the band's emoji. sendDate (YYYY-MM-DD)
 *   goes in the dateline. Any other field is ignored: the shared body takes
 *   no caller text.
 */
function renderIssue(issue) {
  const lead = leadBlock(issue);
  const id = identifierBlock(issue);
  const sections = [lead.text, id.text];
  const minutes = readMinutes([GREETING, INTRO, ...sections, SIGNOFF_TEXT].join(' '));
  const opening = openingBlock(issue, minutes);
  const html = [wrapBlock(opening), wrapBlock(lead), DIVIDER_HTML, wrapBlock(id), SIGNOFF_HTML].join('\n');
  const text = [opening.text, ...sections, SIGNOFF_TEXT].join('\n\n');
  return { subject: issue.subject, preview: issue.preview, html_body: html, text_body: text };
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

// Puts `block` in front of the sign-off that closes `body`; a body with no
// sign-off (one rendered before it existed) gets the block at its end.
function beforeSignoff(body, block, signoff) {
  if (body.endsWith(signoff)) return `${body.slice(0, body.length - signoff.length)}${block}\n${signoff}`;
  return `${body}\n${block}`;
}

/**
 * One reader's block ({ html, text }) after the shared sections, behind the
 * Waves badge and before the sign-off. A new object comes back; `issue` is
 * not changed.
 */
function addReaderBlock(issue, block) {
  return {
    ...issue,
    html_body: beforeSignoff(issue.html_body, `${DIVIDER_HTML}\n${wrapBlock(block)}`, SIGNOFF_HTML),
    text_body: beforeSignoff(issue.text_body, `${block.text}\n`, SIGNOFF_TEXT),
  };
}

/**
 * The issue as an opted-in reader gets it: the shared issue with "A tool
 * we'd use" after "What's this?". Owner 2026-11-19: Amazon links go only to
 * readers who opted in, so the shared issue (renderIssue), which the archive
 * serves to anyone, never has the tool. The send path (PR 4) adds it per
 * recipient, only for a reader with opt-in evidence, and checks that body
 * before it sends. The tool is looked up in the registry as it is now, and
 * renders only while its link is still the one that passed the live check
 * (pre-push PR 3 r4). A tool that is not usable now (paused since the build,
 * unknown, or the registry cannot be read), or whose link changed since the
 * check, is left out: the same `issue` object comes back, so the reader
 * gets the shared copy.
 * @param {{ subject: string, preview: string, html_body: string, text_body: string }} issue  renderIssue's result
 * @param {{ productId: string, url: string }|null} picked  buildIssue's `tool`: its product id and checked link
 */
function withToolBlock(issue, picked) {
  const tool = picked ? toolById(picked.productId) : null;
  if (!tool || tool.url !== picked.url) return issue;
  return addReaderBlock(issue, toolBlock(tool));
}

module.exports = {
  renderIssue, withToolBlock, addReaderBlock, wrapIssueHtml, escapeHtml, speciesEmoji,
  IDENTIFIER_URL, POST_LINK_TEXT, PHOTO_ID_TEXT, VERDICTS, SIGNOFF_TEXT, CATEGORY_EMOJI, SPECIES_EMOJI,
};
