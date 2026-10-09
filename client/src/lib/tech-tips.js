// Tips from your tech — the picker's pure helpers, shared by the completion
// screen's picker (SchedulePage TechTipPicker) and the tech portal's Fast
// Complete sheet. The registry ships whole from
// GET /admin/dispatch/:serviceId/tech-tips and is searched on the client.

const TECH_TIP_SUB_CHARS = 96;

// No lookbehind: Safari before 16.4 fails to PARSE a lookbehind literal and
// the whole dispatch chunk would not load (see SaveCardConsent.jsx).
export function techTipSubtext(copy) {
  const text = String(copy || "");
  const first = (text.match(/^.*?[.!?](?=\s|$)/) || [text])[0] || "";
  return first.length > TECH_TIP_SUB_CHARS ? `${first.slice(0, TECH_TIP_SUB_CHARS - 1).trimEnd()}…` : first;
}

// `lastSent` values are YYYY-MM-DD calendar days (service_date). Never
// `new Date('YYYY-MM-DD')` — that is UTC midnight, the previous ET evening —
// so the day is formatted from its components with no zone in play.
export function techTipSentLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ""));
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(at.getTime())) return null;
  return `sent ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

// Label first, then the tech-vocabulary keywords, then the customer copy.
export function rankTechTips(tips, q) {
  const scored = [];
  for (const tip of tips) {
    const label = tip.label.toLowerCase();
    let score = 0;
    if (label.includes(q)) score = label.startsWith(q) ? 4 : 3;
    else if ((tip.keywords || []).some((k) => k.includes(q))) score = 2;
    else if (String(tip.copy || "").toLowerCase().includes(q)) score = 1;
    if (score) scored.push({ tip, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.tip.label.localeCompare(b.tip.label))
    .map((entry) => entry.tip);
}

// Tips the technician's own note calls for: a tip leads when one of its
// keywords (whole words; a multi-word keyword as a phrase) appears in the
// note. More matched keywords rank higher; ties keep library order. Only
// keywords count, never the customer copy, so "water" in the copy of every
// watering tip does not match a note that says "watered in".
export function tipsCalledForByNote(tips, note) {
  const text = ` ${String(note || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (text.trim().length < 3) return [];
  const scored = [];
  for (const tip of tips) {
    const hits = (tip.keywords || []).filter((k) => {
      const key = String(k).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return key.length >= 3 && text.includes(` ${key} `);
    }).length;
    if (hits) scored.push({ tip, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits).map((entry) => entry.tip.id);
}


// Tips the customer has not had lately lead: a tip sent to this customer in
// the picker's window (`lastSent`, id -> day) moves behind the rest, so a
// recurring visit's short list changes from visit to visit. Order is otherwise
// kept; nothing is hidden.
export function unsentTipsFirst(tips, lastSent) {
  if (!lastSent) return tips;
  return [...tips.filter((tip) => !lastSent[tip.id]), ...tips.filter((tip) => lastSent[tip.id])];
}

// The pest sheet's chips as a note names them (the note is read here only to
// rank tips; the server's own read fills the record).
const NOTE_PESTS = [
  ["Ants", /\bants?\b/],
  ["Roaches", /\b(cock)?roach(es)?\b|\bpalmetto bugs?\b/],
  ["Spiders", /\bspiders?\b|\bwebs?\b/],
  ["Silverfish", /\bsilverfish\b/],
  ["Wasps", /\bwasps?\b|\bhornets?\b|\byellow ?jackets?\b|\bmud daubers?\b/],
  ["Earwigs", /\bearwigs?\b/],
  ["Fleas", /\bfleas?\b/],
  ["Crickets", /\bcrickets?\b/],
  ["Centipedes", /\bcentipedes?\b/],
];

// "No roaches seen" names no pest: a negated phrase is dropped before the read.
const NEGATED_PEST_RE = /\b(?:no|not|zero|without)\s+(?:(?:seeing|finding|see|find)\s+)?(?:(?:signs?|evidence)\s+of\s+|live\s+|new\s+|more\s+|any\s+)?[a-z]+\b/g;

export function pestsInNote(note) {
  const text = String(note || "").toLowerCase().replace(NEGATED_PEST_RE, " ");
  return NOTE_PESTS.filter(([, re]) => re.test(text)).map(([pest]) => pest);
}

const PEST_TIP_LIFT_MAX = 4;

// The tips the pest sheet lifts under "For what you saw today": advice tagged
// for a pest the tech tapped or the note names (from the whole library, so a
// recurring visit reaches roach or flea advice), then the visit's own tips
// whose keywords the note names. Tips for more of the pests lead; tips this
// customer had lately go last, and a tip for the other season (wet or dry) is
// left to search. A short list, and never a pick.
export function pestSheetTipIds(library, { pests = [], note = "" } = {}) {
  const listed = (library?.groups || []).flatMap((group) => group.tips || []);
  const every = [...listed, ...(library?.more || [])];
  const seen = new Set([...pests, ...pestsInNote(note)]);
  const inSeason = (tip) => !tip.season || tip.season === "all" || !library?.season || tip.season === library.season;
  const forPests = every
    .filter(inSeason)
    .map((tip) => ({ tip, hits: (tip.pests || []).filter((pest) => seen.has(pest)).length }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((entry) => entry.tip);
  const byId = new Map(every.map((tip) => [tip.id, tip]));
  const forNote = tipsCalledForByNote(listed, note).map((id) => byId.get(id));
  const lifted = [...new Set([...forPests, ...forNote])];
  return unsentTipsFirst(lifted, library?.lastSent).slice(0, PEST_TIP_LIFT_MAX).map((tip) => tip.id);
}
