/**
 * Pest Insider "A tool we'd use": the reviewed tool items and their Amazon
 * links.
 *
 * Owner 2026-11-19: Amazon links are allowed in this email only, for
 * opted-in readers, approved registry products only, with Amazon's exact
 * sentence next to the link. So each item in
 * server/data/pest-insider-tools-v1.json names a product of the vendored
 * affiliate registry (packages/affiliate-registry; the owner's astro merge
 * is the approval record), and its link is that row's approved URL, never a
 * URL from the list. The registry's allowed_placements and
 * allowed_post_types name places on the blog; this email is not one of
 * them, and the owner's 11-19 ruling is its approval, so they are not read
 * here.
 *
 * Two kinds of check. The list's own checks (name, lines, services) read
 * only the file, so they run once. The registry's checks (an active, green
 * Amazon row with a tagged product link) run on the registry as it is each
 * time a tool is picked or rendered (loadTools): the registry reloads its
 * file when it changes, so a row paused or relinked while the process runs
 * takes effect at once (pre-push PR 3 r3). An item that fails a check is
 * left out and named in `problems`. The tests hold the shipped list to no
 * problem; at run time a bad item, or a registry file that cannot be read
 * (it loads as empty: the registry's dark posture), only drops tools, so an
 * issue without a tool still builds (pre-push PR 3 r2).
 *
 * A product page can die or change after review (the door sweep's did), so
 * a send names the tool links whose page passed a live check
 * (`liveToolUrls`), and a tool is picked and rendered only while its link is
 * one of them. An issue with no live tool has no tool item.
 */
'use strict';

const data = require('../../data/pest-insider-tools-v1.json');
const registry = require('../../../packages/affiliate-registry');
const { toolLineProblem, salesWordProblem, bannedReason } = require('./claim-check');
const { FACTS } = require('./facts');

/** Amazon's required sentence, next to every tool link. */
const AMAZON_DISCLOSURE = 'As an Amazon Associate I earn from qualifying purchases.';

// An Amazon product page with our tag and nothing else: no other query
// value and no fragment.
const AMAZON_URL = /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}\?tag=wavespestcont-20$/;
// A plain generic name in sentence case ("Rain gauge"), never a brand.
const NAME = /^[A-Z][a-z]+(?: [a-z]+){0,3}$/;
const SERVICES = new Set(FACTS.map((f) => f.service));

// The generic words of a registry display name: its words that start with a
// lowercase letter ("glass rain gauge" in "AcuRite 00810A2 glass rain
// gauge"). A brand or model word starts with a capital or a digit ("AcuRite",
// "00810A2", "Stuff-It"). The tool's name is the link text and the source of
// its lines, so every word of it is one of these: it says only what the
// approved product is, with no brand, place or sales word (pre-push PR 3 r5).
const genericWords = (displayName) => String(displayName || '').split(/[\s()/,-]+/).filter((w) => /^[a-z]/.test(w));

const idOf = (entry) => (entry && typeof entry.product_id === 'string' && entry.product_id) || '(no product_id)';

// The list's own checks: they read only the file.
function entryProblem(entry, counts) {
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  const id = entry.product_id;
  if (typeof id !== 'string' || !id) return 'product_id is missing';
  if (counts.get(id) > 1) return 'is listed twice';
  const { name } = entry;
  if (typeof name !== 'string' || !NAME.test(name) || bannedReason(name)) return 'name must be a plain generic name in sentence case ("Rain gauge")';
  if (salesWordProblem(name)) return `name has ${salesWordProblem(name)}`;
  if (!Array.isArray(entry.lines) || ![1, 2].includes(entry.lines.length)) return 'needs 1 or 2 lines';
  for (const line of entry.lines) {
    // toolLineProblem's plain-sentence rule refuses a blank, untrimmed or
    // two-line string.
    if (typeof line !== 'string') return 'each line must be text';
    const reason = toolLineProblem(line, { name });
    if (reason) return `line "${line}": ${reason}`;
  }
  if (!Array.isArray(entry.services) || !entry.services.length || entry.services.some((s) => !SERVICES.has(s))) {
    return 'services must list fact-bank services';
  }
  return null;
}

// The registry's checks, on the row as it is now.
function rowProblem(entry, index) {
  const hit = index.get(entry.product_id);
  if (!hit) return 'is not in the affiliate registry';
  if (hit.state !== 'active') return `its registry row is ${hit.state}, not active`;
  if (hit.row.risk_class !== 'green') return `its registry row is ${hit.row.risk_class}, not green (no pesticide in this email)`;
  if (hit.row.merchant !== 'amazon') return 'its registry row is not an Amazon product';
  if (!AMAZON_URL.test(String(hit.row.approved_affiliate_url))) return 'its registry URL is not a tagged Amazon product page';
  const generic = genericWords(hit.row.display_name);
  const word = entry.name.toLowerCase().split(' ').find((w) => !generic.includes(w));
  return word ? `name word "${word}" is not a generic word of its registry name` : null;
}

// An item's fields, read once into a new object. The check and the tools
// use only this copy, so a later change to the required JSON (one object in
// Node's shared module cache) cannot reach copy that passed the check
// (pre-push PR 3 r6).
const snapshot = (entry) => (entry && typeof entry === 'object' ? {
  product_id: entry.product_id,
  name: entry.name,
  lines: Array.isArray(entry.lines) ? [...entry.lines] : entry.lines,
  services: Array.isArray(entry.services) ? [...entry.services] : entry.services,
} : entry);

// Runs the list's own checks once: frozen copies of the entries that pass,
// and a line for each item left out. A product listed twice is left out
// both times.
function listCheck(raw) {
  if (!raw || !Array.isArray(raw.tools)) return { entries: [], problems: ['the file has no tools list'] };
  const copies = raw.tools.map(snapshot);
  const counts = new Map();
  for (const entry of copies) {
    const id = entry && entry.product_id;
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  }
  const entries = [];
  const problems = [];
  for (const entry of copies) {
    const problem = entryProblem(entry, counts);
    if (problem) problems.push(`${idOf(entry)}: ${problem}`);
    else entries.push(Object.freeze({ ...entry, lines: Object.freeze(entry.lines), services: Object.freeze(entry.services) }));
  }
  return { entries: Object.freeze(entries), problems };
}

function withRegistry({ entries, problems }, index) {
  const tools = [];
  const all = [...problems];
  for (const entry of entries) {
    const problem = rowProblem(entry, index);
    if (problem) {
      all.push(`${entry.product_id}: ${problem}`);
    } else {
      tools.push(Object.freeze({
        productId: entry.product_id,
        name: entry.name,
        lines: entry.lines,
        services: entry.services,
        url: index.get(entry.product_id).row.approved_affiliate_url,
      }));
    }
  }
  return { tools: Object.freeze(tools), problems: Object.freeze(all) };
}

/**
 * Both checks on a tools list, against a registry index (the tests use it).
 * @param {{ tools: object[] }} raw  a tools file
 * @param {Map<string, { row: object, state: string }>} [index]  registry.productIndex()
 * @returns {{ tools: ReadonlyArray<{ productId: string, name: string, lines: string[], services: string[], url: string }>,
 *   problems: ReadonlyArray<string> }}  the usable tools, and one line for each item left out
 */
const checkTools = (raw, index = registry.productIndex()) => withRegistry(listCheck(raw), index);

const LIST = listCheck(data);

/** The reviewed list's usable tools and problems, against the registry as it is now. */
const loadTools = () => withRegistry(LIST, registry.productIndex());

/** A usable tool by its product id, against the registry as it is now, or null. */
const toolById = (productId) => loadTools().tools.find((t) => t.productId === productId) || null;

/** The tool's link text: its generic name, then where it is sold. */
const toolLinkText = (tool) => `${tool.name} on Amazon`;

module.exports = { AMAZON_DISCLOSURE, loadTools, toolById, toolLinkText, checkTools };
