/**
 * Email domain typo correction — recovers mis-transcribed consumer email
 * addresses for the bounce-recovery pipeline (server/services/email-bounce-recovery.js).
 *
 * SAFETY: this NEVER edits the local part (the text before "@"). Editing the
 * local part could silently deliver to a different real person's inbox. We only
 * correct the DOMAIN/TLD, which preserves recipient identity — that is the whole
 * reason domain-only correction is safe to send fully automatically.
 *
 * Scope is deliberately conservative: we only correct TOWARD a small set of
 * well-known consumer mailbox providers. A typo in an unknown business domain
 * (e.g. "compamy.com") is left alone — we cannot know the intended address, so
 * we return null rather than guess.
 *
 * Returns { corrected, rule, confidence } or null when there is no safe fix.
 *   rule:       'missing_dot' | 'tld_fix' | 'domain_typo'
 *   confidence: 'high'   — a single edit (incl. transposition) to a known domain,
 *                          or an unambiguous missing-dot / known-bad-TLD fix
 *               'medium' — a two-edit distance to a known domain
 */

// Canonical consumer mailbox domains. Keep this list tight: every entry is a
// provider real customers actually type, and the correction only ever lands on
// one of these. Order does not matter.
const KNOWN_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'protonmail.com',
  'proton.me',
];

const KNOWN_DOMAIN_SET = new Set(KNOWN_DOMAINS);

// second-level-domain -> canonical full domain (e.g. 'comcast' -> 'comcast.net').
// When a second-level label is unique across the known list we can fix a wrong
// TLD ('comcast.com' -> 'comcast.net') with high confidence. Ambiguous SLDs
// (none today, but future-proofed) are dropped so we never guess the TLD.
const SLD_TO_DOMAIN = (() => {
  const counts = new Map();
  for (const d of KNOWN_DOMAINS) {
    const sld = d.slice(0, d.lastIndexOf('.'));
    counts.set(sld, (counts.get(sld) || 0) + 1);
  }
  const map = new Map();
  for (const d of KNOWN_DOMAINS) {
    const sld = d.slice(0, d.lastIndexOf('.'));
    if (counts.get(sld) === 1) map.set(sld, d);
  }
  return map;
})();

// Domains with no dot at all map straight back to their canonical form. Built
// once so 'gmailcom' -> 'gmail.com' is an O(1) lookup.
const DOTLESS_TO_DOMAIN = (() => {
  const map = new Map();
  for (const d of KNOWN_DOMAINS) map.set(d.replace(/\./g, ''), d);
  return map;
})();

// Common wrong TLDs we've seen for ".com" providers — fat-finger and spoken
// mis-hears ("dot com" -> "dot con"). Used to mark a TLD fix high-confidence
// even when the edit distance heuristic alone would be cautious.
const KNOWN_BAD_COM_TLDS = new Set([
  'con', 'cpm', 'cmo', 'ocm', 'vom', 'comm', 'cim', 'xom', 'clm',
  'co', 'cm', 'om', 'coom', 'coam', 'cojm',
]);

/**
 * Optimal String Alignment (restricted Damerau–Levenshtein) distance.
 * Counts an adjacent transposition as a single edit, so the very common
 * "gmial" -> "gmail" mis-type is distance 1, not 2.
 */
function damerauLevenshtein(a = '', b = '') {
  a = String(a);
  b = String(b);
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[al][bl];
}

/** Split into { local, domain } or null when the shape is not a plain address. */
function splitEmail(email) {
  const value = String(email == null ? '' : email).trim().toLowerCase();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null; // no local or no domain
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.includes('@') || !local || !domain) return null;
  if (/\s/.test(value)) return null;
  return { local, domain };
}

function closestKnownDomain(domain) {
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_DOMAINS) {
    const dist = damerauLevenshtein(domain, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return { domain: best, distance: bestDist };
}

/**
 * Produce a safe domain correction for a likely-mistyped address, or null.
 * @param {string} email
 * @returns {{corrected: string, rule: string, confidence: 'high'|'medium'}|null}
 */
function correctEmailDomain(email) {
  const parts = splitEmail(email);
  if (!parts) return null;
  const { local, domain } = parts;

  // Already a known-good consumer domain — nothing to fix.
  if (KNOWN_DOMAIN_SET.has(domain)) return null;

  const build = (correctedDomain, rule, confidence) => {
    if (!correctedDomain || correctedDomain === domain) return null;
    return { corrected: `${local}@${correctedDomain}`, rule, confidence };
  };

  // Rule 1 — missing dot: "gmailcom" -> "gmail.com". Highest confidence; this
  // is a deterministic reconstruction, not a guess.
  if (!domain.includes('.')) {
    const exact = DOTLESS_TO_DOMAIN.get(domain);
    if (exact) return build(exact, 'missing_dot', 'high');
    // Fall through to fuzzy match below in case it's dotless AND mistyped.
  }

  // Rule 2 — wrong TLD on a known provider: "gmail.con" -> "gmail.com",
  // "comcast.com" -> "comcast.net". The second-level label must be a known
  // provider so we know the correct TLD.
  if (domain.includes('.')) {
    const lastDot = domain.lastIndexOf('.');
    const sld = domain.slice(0, lastDot);
    const tld = domain.slice(lastDot + 1);
    const canonical = SLD_TO_DOMAIN.get(sld);
    if (canonical && canonical !== domain) {
      const canonicalTld = canonical.slice(canonical.lastIndexOf('.') + 1);
      const tldDist = damerauLevenshtein(tld, canonicalTld);
      if (KNOWN_BAD_COM_TLDS.has(tld) && canonicalTld === 'com') {
        return build(canonical, 'tld_fix', 'high');
      }
      if (tldDist === 1) return build(canonical, 'tld_fix', 'high');
      if (tldDist === 2) return build(canonical, 'tld_fix', 'medium');
    }
  }

  // Rule 3 — fuzzy match the whole domain to the nearest known provider.
  // Damerau distance 1 (incl. transposition) is high; distance 2 is medium.
  const { domain: nearest, distance } = closestKnownDomain(domain);
  if (nearest && nearest !== domain) {
    if (distance === 1) return build(nearest, 'domain_typo', 'high');
    if (distance === 2) return build(nearest, 'domain_typo', 'medium');
  }

  return null;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/** True when `confidence` meets or exceeds `minimum`. */
function meetsConfidence(confidence, minimum = 'high') {
  return (CONFIDENCE_RANK[confidence] || 0) >= (CONFIDENCE_RANK[minimum] || CONFIDENCE_RANK.high);
}

module.exports = {
  KNOWN_DOMAINS,
  damerauLevenshtein,
  splitEmail,
  correctEmailDomain,
  meetsConfidence,
};
