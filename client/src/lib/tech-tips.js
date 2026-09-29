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
