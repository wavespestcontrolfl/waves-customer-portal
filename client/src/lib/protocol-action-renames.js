// A close-out draft stores each checked protocol action by its exact card-line text. When a card line is reworded
// (the 2026-11-27 card wording slim-down), a draft saved under the old text no longer matches any offered action:
// it would restore unchecked, and checking the new line would submit both wordings. On restore, a saved label that
// is no longer offered maps to the current line when one matches after normalizing (case, spacing, end punctuation)
// or through the former-text map (old line -> new line, generated from that branch's renames). A former card line
// that maps to nothing offered is dropped, so it is never submitted. Any other label is left to the submit allowlist.
import FORMER_ACTION_TEXT from "./protocol-action-former-text.json";

const normalized = (text) => String(text || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .replace(/[\s.;:,]+$/, "")
  .trim();

export function remapRestoredActionLabels(labels, offeredLabels, former = FORMER_ACTION_TEXT) {
  const offered = new Map();
  (offeredLabels || []).forEach((label) => {
    const text = String(label || "").trim();
    if (text && !offered.has(normalized(text))) offered.set(normalized(text), text);
  });
  const next = [];
  const renames = {};
  const dropped = [];
  const keep = (label) => { if (!next.includes(label)) next.push(label); };
  (labels || []).forEach((label) => {
    const text = String(label || "").trim();
    if (offered.get(normalized(text)) === text) return keep(label);
    const formerTarget = Object.hasOwn(former, text) ? former[text] : null;
    const target = offered.get(normalized(text)) || (formerTarget != null ? offered.get(normalized(formerTarget)) : undefined);
    if (target) {
      renames[label] = target;
      return keep(target);
    }
    if (formerTarget != null) return dropped.push(label);
    return keep(label);
  });
  return { labels: next, renames, dropped };
}
