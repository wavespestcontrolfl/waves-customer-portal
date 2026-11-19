'use strict';

/**
 * Source evidence from the address an inquiry email was sent to.
 *
 * Every website email link is a tagged plus-address,
 *   contact+<code>_<page>@<domain>
 * and Google Workspace delivers it to the same contact@ inbox. The tag is
 * untrusted: anyone can send to any address, so only an allowlisted code plus a
 * page slug of the exact shape the site writes is read. Anything else is
 * ignored. The result has the shape lead-source-evidence.js persists
 * ({kind, label, detail, basis}) and its labels come from that module's maps.
 *
 * Pure: no database, no network, no clock.
 */
const { EVIDENCE_KINDS, SEARCH_HOSTS, SOCIAL_HOSTS } = require('../lead-source-evidence');
const { SPOKE_SITE_KEYS, HUB_SITE_KEYS } = require('../content-astro/spoke-sites');
const { findGbpLocationByUtmContent } = require('../../config/locations');
const { extractEmailAddresses } = require('./email-customer-link');

// Our own website domains: the hub, waveslawncare.com and every spoke.
const OWN_DOMAINS = new Set(SPOKE_SITE_KEYS);
const HUB_DOMAINS = new Set(HUB_SITE_KEYS);
const MAILBOX_LOCAL = 'contact';
const PAGE_RE = /^[a-z0-9-]{1,55}$/;
const TAGGED_LOCAL_RE = /^contact\+([a-z]+(?:-[a-z]+)?)_([^_]+)$/;

// Representative host per engine/network so the display names come from the
// same maps sourceEvidenceFromAttribution uses.
const SEARCH_ENGINE_HOSTS = {
  google: 'google.com', bing: 'bing.com', duckduckgo: 'duckduckgo.com',
  yahoo: 'search.yahoo.com', brave: 'search.brave.com', ecosia: 'ecosia.org',
};
const SOCIAL_NETWORK_HOSTS = {
  facebook: 'facebook.com', instagram: 'instagram.com', nextdoor: 'nextdoor.com',
  linkedin: 'linkedin.com', x: 'x.com',
};

// code -> evidence parts. `detail` is the short source phrase that opens the
// readable detail line.
const FIXED_CODES = {
  gbp: { kind: 'google_business', label: 'Google Business Profile', detail: 'GBP — profile website link' },
  gads: { kind: 'google_ads', label: 'Google Ads', detail: 'Google Ads' },
  meta: { kind: 'meta_ads', label: 'Meta Ads', detail: 'Meta Ads' },
  'ai-chatgpt': { kind: 'chatgpt', label: 'ChatGPT', detail: 'AI search' },
  'ai-copilot': { kind: 'copilot', label: 'Microsoft Copilot', detail: 'AI search' },
  ai: { kind: 'other_ai', label: 'AI referral', detail: 'AI search' },
  search: { kind: 'organic_search', label: 'Organic search', detail: 'Organic search' },
  social: { kind: 'organic_social', label: 'Organic social', detail: 'Organic social' },
  ref: { kind: 'referral', label: 'Referral', detail: 'Referring website' },
  direct: { kind: 'direct', label: 'Direct', detail: 'No referring site' },
  site: { kind: 'website', label: 'Website', detail: 'Website' },
};

function cap(value, max) {
  const s = String(value || '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function evidence(kind, label, detail, basis) {
  if (!EVIDENCE_KINDS.has(kind)) return null;
  return { kind, label: cap(label, 80), detail: detail ? cap(detail, 120) : null, basis: cap(basis, 240) };
}

// Resolve a tag code to { kind, label, detail } or null for an unknown code.
// Own-property lookups only: a code such as `constructor` must never match an
// inherited Object property.
function describeCode(code) {
  if (Object.hasOwn(FIXED_CODES, code)) return FIXED_CODES[code];
  const dash = code.indexOf('-');
  if (dash < 1) return null;
  const family = code.slice(0, dash);
  const name = code.slice(dash + 1);
  if (family === 'gbp') {
    // The contract names location ids only; findGbpLocationByUtmContent also
    // accepts UTM aliases, so an alias must not pass as a code.
    const location = findGbpLocationByUtmContent(name);
    if (!location || location.id !== name) return null;
    return { kind: 'google_business', label: 'Google Business Profile', detail: `GBP — ${location.name}` };
  }
  if (family === 'search' && Object.hasOwn(SEARCH_ENGINE_HOSTS, name)) {
    const engine = SEARCH_HOSTS.get(SEARCH_ENGINE_HOSTS[name]);
    return { kind: 'organic_search', label: 'Organic search', detail: engine };
  }
  if (family === 'social' && Object.hasOwn(SOCIAL_NETWORK_HOSTS, name)) {
    const network = SOCIAL_HOSTS.get(SOCIAL_NETWORK_HOSTS[name]);
    return { kind: 'organic_social', label: 'Organic social', detail: network };
  }
  return null;
}

function splitAddress(address) {
  const at = address.lastIndexOf('@');
  return at > 0 ? { local: address.slice(0, at), domain: address.slice(at + 1) } : null;
}

/**
 * Our own mailbox address without a "+tag", so contact+gbp-sarasota_home@
 * reads as contact@. Narrow: the tag is stripped only on the hub domain, the
 * one mailbox the site tags (Google Workspace delivers plus-addresses; spoke
 * and lawn-care mail forwards through Cloudflare, and the site never tags it).
 * Any other address (a customer's included) comes back lowercased and
 * untouched.
 */
function ownMailboxAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  const parts = splitAddress(address);
  if (!parts || !HUB_DOMAINS.has(parts.domain)) return address;
  const plus = parts.local.indexOf('+');
  return plus > 0 ? `${parts.local.slice(0, plus)}@${parts.domain}` : address;
}

// A valid tag on the hub domain: { code, page, domain, descriptor } or null.
function parseTaggedAddress(address) {
  const parts = splitAddress(address);
  if (!parts || !HUB_DOMAINS.has(parts.domain)) return null;
  const match = TAGGED_LOCAL_RE.exec(parts.local);
  if (!match || !PAGE_RE.test(match[2])) return null;
  const descriptor = describeCode(match[1]);
  return descriptor ? { code: match[1], page: match[2], domain: parts.domain, descriptor } : null;
}

function taggedEvidence({ page, domain, descriptor }) {
  const pageText = page === 'home' ? 'home page' : `page ${page}`;
  return evidence(
    descriptor.kind,
    descriptor.label,
    `${descriptor.detail} · email link, ${pageText}`,
    `The email was sent to a tagged website email link on ${domain} (${pageText}). The tag is written by the site, so it is a hint, not proof.`,
  );
}

function ownSiteEvidence(domain) {
  return evidence(
    'website',
    'Website',
    domain,
    `The email went to contact@${domain}, the address the ${domain} website shows. It is a hint, not proof: that site does not tag its email links.`,
  );
}

/**
 * Source evidence for an inbound email row, or null (the lead keeps its
 * "Email inquiry" label).
 *   1. A valid tagged address on the hub domain wins (first one found).
 *   2. No valid tag, but the mail went to contact@ on a spoke or lawn-care
 *      domain: website evidence naming that domain.
 *   3. Anything else (contact@ on the main domain, a foreign address): null.
 */
function emailSourceEvidence(email = {}) {
  const addresses = extractEmailAddresses([email.to_address, email.cc_address].filter(Boolean).join(','));
  for (const address of addresses) {
    const tagged = parseTaggedAddress(address);
    if (tagged) return taggedEvidence(tagged);
  }
  for (const address of addresses) {
    const parts = splitAddress(address);
    if (!parts || !OWN_DOMAINS.has(parts.domain) || HUB_DOMAINS.has(parts.domain)) continue;
    if (parts.local === MAILBOX_LOCAL || parts.local.startsWith(`${MAILBOX_LOCAL}+`)) return ownSiteEvidence(parts.domain);
  }
  return null;
}

module.exports = { emailSourceEvidence, ownMailboxAddress };
