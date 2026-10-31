// Renders the engine's v2 answer in the same order as the Waves app
// (client/src/components/portal/PhotoId.jsx V2Result): headline -> tier ->
// photos -> verdict + safety -> about -> evidence -> next photo -> other
// possibilities -> referral. Every string is set as text, never as HTML.
import { QUOTE_URL, SPECIES_PAGE_PREFIX, withUtm } from './config.js';

const TIER_LABELS = { ai_suggestion: 'AI suggestion', needs_more_evidence: 'Needs more evidence' };
const VERDICT_TONES = new Set(['ally', 'harmless', 'watch', 'call']);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const str = (value) => (typeof value === 'string' && value.trim() ? value : null);

function chip(text, tone = 'neutral') {
  return h('span', { class: `chip chip-${tone}`, text });
}

function labeledLine(label, value) {
  if (!str(value)) return null;
  return h('p', { class: 'line' }, h('strong', { text: `${label}: ` }), value);
}

function safetyLine(text) {
  return str(text) ? h('p', { class: 'safety', text }) : null;
}

function speciesLink(entry) {
  const url = str(entry.site_url);
  if (!url || !url.startsWith(SPECIES_PAGE_PREFIX)) return null;
  return h('a', {
    class: 'link', href: withUtm(url, 'species-profile'), target: '_blank', rel: 'noopener',
    text: `Read the full ${entry.common_name} profile`,
  });
}

function aboutSection(entry) {
  const lookAlikes = Array.isArray(entry.look_alikes) ? entry.look_alikes.filter((l) => str(l && l.common_name)) : [];
  const link = speciesLink(entry);
  if (!str(entry.what_it_means) && !str(entry.fact) && !lookAlikes.length && !link) return null;
  return h('details', { class: 'about' },
    h('summary', { text: `About ${entry.common_name}` }),
    str(entry.what_it_means) && h('p', { text: entry.what_it_means }),
    str(entry.fact) && h('p', { text: entry.fact }),
    lookAlikes.length > 0 && h('div', {},
      h('p', { class: 'eyebrow', text: 'Commonly confused with' }),
      lookAlikes.map((l) => h('p', { class: 'line' }, h('strong', { text: l.common_name }), str(l.difference) ? ` — ${l.difference}` : ''))),
    link);
}

function photoStrip(photos) {
  if (!photos.length) return null;
  return h('div', { class: 'photos' },
    photos.map((p, i) => h('img', { src: `data:${p.mimeType};base64,${p.data}`, alt: `Your photo ${i + 1}` })));
}

function mainCard(v2, photos) {
  const answer = v2.answer || {};
  const entry = v2.entry || null;
  const tone = entry && VERDICT_TONES.has(entry.verdict) ? entry.verdict : 'neutral';
  return h('section', { class: 'card result-main' },
    h('h2', { class: 'headline', text: str(answer.headline) || 'Result' }),
    str(answer.subhead) && h('p', { class: 'subhead', text: answer.subhead }),
    TIER_LABELS[v2.tier] && h('p', { class: 'eyebrow', text: TIER_LABELS[v2.tier] }),
    photoStrip(photos),
    !entry && safetyLine(v2.generic_safety_line),
    entry && [
      str(entry.verdict_label) && h('div', { class: 'chips' }, chip(entry.verdict_label, tone)),
      safetyLine(entry.safety_line),
      labeledLine('What it is', entry.role_label),
      labeledLine('Risk', entry.risk_label),
      labeledLine('What to do', entry.action_label),
      aboutSection(entry),
    ]);
}

function evidenceCard(evidence) {
  const matches = Array.isArray(evidence && evidence.matches) ? evidence.matches.filter(str) : [];
  const stillNeed = Array.isArray(evidence && evidence.still_need) ? evidence.still_need.filter(str) : [];
  if (!matches.length && !stillNeed.length) return null;
  return h('section', { class: 'card' },
    matches.length > 0 && [h('p', { class: 'eyebrow', text: 'What matches' }), h('ul', { class: 'list list-check' }, matches.map((t) => h('li', { text: t })))],
    stillNeed.length > 0 && [h('p', { class: 'eyebrow', text: 'What we still need to see' }), h('ul', { class: 'list list-eye' }, stillNeed.map((t) => h('li', { text: t })))]);
}

function nextPhotoCard(nextPhoto, { canAddPhoto, onAddPhoto }) {
  if (!nextPhoto) return null;
  const canConfirm = nextPhoto.photo_can_confirm !== false;
  return h('section', { class: 'card' },
    h('h3', { text: canConfirm ? 'A photo that would help confirm it' : "A photo can't confirm this one" }),
    str(nextPhoto.ask) && h('p', { text: nextPhoto.ask }),
    str(nextPhoto.why) && h('p', { class: 'muted', text: nextPhoto.why }),
    safetyLine(nextPhoto.safety_line),
    canConfirm && canAddPhoto && h('button', { type: 'button', class: 'btn btn-secondary', text: 'Add this photo', onclick: () => onAddPhoto(nextPhoto) }));
}

function candidatesCard(candidates, hasEntry) {
  if (!Array.isArray(candidates)) return null;
  const others = (hasEntry ? candidates.slice(1) : candidates).filter((c) => c && str(c.common_name));
  if (!others.length) return null;
  return h('section', { class: 'card' },
    h('p', { class: 'eyebrow', text: 'Other possibilities' }),
    others.map((c) => h('div', { class: 'candidate' },
      h('div', { class: 'chips' },
        h('strong', { text: c.common_name }),
        chip(c.strength === 'strong' ? 'Strong match' : 'Possible match'),
        c.local === 'common_here_now' && chip('Common here now', 'ally'),
        c.local === 'uncommon_here' && chip('Uncommon here')),
      safetyLine(c.safety_line),
      str(c.difference_from_top) && h('p', { class: 'muted', text: c.difference_from_top }))));
}

function wavesCard(v2) {
  // A referral (bees, wildlife, a report to the state) is not pest control's
  // job, so it gets no sales pitch.
  if (v2.referral && str(v2.referral.text)) {
    return h('section', { class: 'card referral' }, h('p', { text: v2.referral.text }));
  }
  const slug = (v2.entry && v2.entry.slug) || 'unknown';
  return h('section', { class: 'card waves' },
    h('h3', { text: 'Bugs at home in Southwest Florida?' }),
    h('p', { text: 'Waves Pest Control serves Manatee, Sarasota and Charlotte counties.' }),
    h('a', { class: 'btn btn-primary', href: withUtm(QUOTE_URL, slug), target: '_blank', rel: 'noopener', text: 'Get a free estimate' }));
}

/** Replace `container`'s content with the rendered answer. */
export function renderResult(container, v2, { photos, canAddPhoto, onAddPhoto, onReset }) {
  container.replaceChildren(...[
    mainCard(v2, photos),
    evidenceCard(v2.evidence),
    nextPhotoCard(v2.next_photo, { canAddPhoto, onAddPhoto }),
    candidatesCard(v2.candidates, !!v2.entry),
    wavesCard(v2),
    h('button', { type: 'button', class: 'btn btn-ghost', text: 'Identify another bug', onclick: onReset }),
  ].filter(Boolean));
}
