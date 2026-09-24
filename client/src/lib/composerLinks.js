export const STATIC_COMPOSER_LINKS = [
  {
    key: "portal_login",
    name: "Portal login",
    url: "portal.wavespestcontrol.com/login",
    clause: "Manage your account and appointments here",
    keywords: "portal login account app sign in manage",
  },
  // Cancellation lands IN the portal (owner ruling 2026-09-03): the cancel
  // flow lives on the My Plan tab behind login, so the link is the login
  // page with the plan tab as its post-login destination (LoginPage's
  // safeNextPath honors ?next=; same encoded form the project emails use).
  {
    key: "cancel_plan",
    name: "Cancel plan link",
    url: "portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dplan",
    clause: "You can review or cancel your plan from your account here",
    keywords: "cancel cancellation stop plan end service quit",
  },
].map((link) => ({ ...link, category: "customer" }));

// Append a static link clause to the composer body (empty body gets the
// clause alone). Returns the body unchanged when the URL is already present
// — a second click must not stack a duplicate link.
export function appendStaticLinkClause(body, { url, clause }) {
  const b = String(body || "");
  if (b.includes(url)) return b;
  if (!b.trim()) return clause;
  return `${b.replace(/\s+$/, "")}\n\n${clause}`;
}

// The rendered insert text for a library row: "{clause}: {url}" with the
// row's name standing in when no clause was authored (sitemap rows).
export function libraryLinkClause(link) {
  const prefix = String(link.clause || "").trim() || String(link.name || "").trim() || "More info";
  return `${prefix}: ${link.url}`;
}

// ── Consultation-clause merge (shared with CustomerSmsPanel) ────────────
//
// Every consultation short link mints a FRESH short code on each insert (a
// new 14-day token), so a repeat insert can never recognize a prior one by
// exact URL match the way a static link (appendStaticLinkClause above)
// can — and an operator edit to even one character of the inserted URL
// makes that insert's OWN url unrecognizable too (Codex #4709 P2, both
// CustomerSmsPanel.jsx and CommunicationsPageV2.jsx). Extracted from
// CustomerSmsPanel's originally-reviewed combineAppendedDraft so both
// composers share one merge: exact remembered line → remembered line's
// URL still present → wording+host heuristic, with the replaced invite's
// own footer lines (e.g. "Reply STOP to opt out.") dropped so the new
// insertion never doubles them.

// The first http(s) URL a text contains, and the host it points at (scheme
// + path ignored). Scheme-free links count too (Codex #4709 P1): the SMS
// template renderer strips https://, so the real consultation line reads
// "wavespest.co/l/abc". A scheme-free match needs a dotted host AND a
// path, so ordinary prose ("it's Waves.") never reads as a URL.
// No regex lookbehind (Codex #4709 r5 P2): Safari/WKWebView before 16.4
// cannot parse it, and CustomerSmsPanel runs on phones. The boundary is a
// captured leading start-of-text or separator instead.
export function firstUrlIn(text) {
  const str = String(text || "");
  const withScheme = str.match(/https?:\/\/\S+/i);
  if (withScheme) return withScheme[0];
  const bare = str.match(/(^|[\s(<"'])((?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+)/i);
  return bare ? bare[2] : null;
}
export function urlHost(url) {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withScheme).host.toLowerCase(); } catch { return null; }
}

export const CONSULTATION_WORDING_RE = /consultation/i;

// The single line inside a consultation addition that carries its URL —
// what's remembered by a caller (alongside its own draft persistence) and
// what combineAppendedDraft below matches on the NEXT insert. Pure: reads
// nothing, has no side effect.
export function consultationLineOf(addition) {
  const text = String(addition || "");
  const host = urlHost(firstUrlIn(text));
  if (!host) return null;
  const lines = text.split("\n");
  return lines.find((line) => urlHost(firstUrlIn(line)) === host) || lines[0];
}

// combineAppendedDraft is PURE — no storage reads or writes. `remembered`
// (the previously inserted consultation line, or null/undefined when
// nothing is remembered for the current recipient) must be resolved by the
// CALLER before any state update (Codex #4709 P1): React StrictMode runs a
// setState updater twice with the same previous draft, so an updater that
// read the remembered line and then overwrote it would see the NEW line on
// its second run and fail to strip the old link. Callers persist the draft
// and the new remembered line outside the updater.
export function combineAppendedDraft(existing, addition, remembered) {
  if (!addition) return existing;
  const base = String(existing || "");
  const newHost = urlHost(firstUrlIn(addition));
  if (newHost) {
    // The remembered line is trusted only while it is still in the draft
    // verbatim (Codex #4709 r5 P2): an operator edit to that line leaves the
    // memory stale, and exact matching would then keep the old invite. Fall
    // back to the wording + host heuristic in that case.
    const rememberedPresent = remembered && base.split("\n").includes(remembered);
    // An EDITED remembered line is still found by its own link (Codex #4709
    // r10 P2) — the URL the operator did not change — so rewording the
    // invite ("inspection" for "consultation") never leaves the old bearer
    // behind. The wording + host heuristic is only for when nothing is
    // remembered at all.
    // ...and when the remembered URL itself was edited away (Codex #4709 r14
    // P2), the wording + host heuristic takes over.
    const rememberedUrl = remembered ? firstUrlIn(remembered) : null;
    const baseLines = base.split("\n");
    const rememberedUrlPresent = Boolean(rememberedUrl) && baseLines.some((line) => line.includes(rememberedUrl));
    const isPriorClauseLine = (line) => {
      if (rememberedPresent) return line === remembered;
      if (rememberedUrlPresent) return line.includes(rememberedUrl);
      return urlHost(firstUrlIn(line)) === newHost && CONSULTATION_WORDING_RE.test(line);
    };
    // The replaced invite's own footer (the STOP line) goes with it, so the
    // new one is never doubled.
    const replacing = baseLines.some(isPriorClauseLine);
    const additionFooters = new Set(addition.split("\n").map((line) => line.trim()).filter((line) => line && !firstUrlIn(line)));
    const withoutPriorClause = baseLines
      .filter((line) => !isPriorClauseLine(line) && !(replacing && additionFooters.has(line.trim())))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return withoutPriorClause ? `${withoutPriorClause}\n\n${addition}` : addition;
  }
  const trimmedBase = base.replace(/\s+$/, "");
  return trimmedBase ? `${trimmedBase}\n\n${addition}` : addition;
}

