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
 * URL from the list. A listed product that is not an active, green Amazon
 * row, or a name or line that fails the copy rule, fails the load: the list
 * and the registry ship in the same repo, so a test catches the mismatch.
 * A green row's state does not change with the clock (only a yellow row's
 * label review ages), so a load that passed in CI passes in production.
 * The registry's allowed_placements and allowed_post_types name places on
 * the blog; this email is not one of them, and the owner's 11-19 ruling is
 * its approval, so they are not read here.
 *
 * A product page can die or change after review (the door sweep's did), so
 * a send names the tools whose page passed a live check (`liveToolIds`) and
 * no other tool is picked. An issue with no live tool has no tool item.
 */
'use strict';

const data = require('../../data/pest-insider-tools-v1.json');
const registry = require('../../../packages/affiliate-registry');
const { toolLineProblem, bannedReason } = require('./claim-check');
const { FACTS } = require('./facts');

/** Amazon's required sentence, next to every tool link. */
const AMAZON_DISCLOSURE = 'As an Amazon Associate I earn from qualifying purchases.';

// An Amazon product page with our tag and nothing else: no other query
// value and no fragment.
const AMAZON_URL = /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}\?tag=wavespestcont-20$/;
// A plain generic name in sentence case ("Rain gauge"), never a brand.
const NAME = /^[A-Z][a-z]+(?: [a-z]+){0,3}$/;
const SERVICES = new Set(FACTS.map((f) => f.service));

// The brand words of a registry display name: its words that start with a
// capital or a digit ("AcuRite", "00810A2", "Stuff-It" = stuff, it). The
// generic name uses none.
const brandWords = (displayName) => String(displayName || '').split(/[\s()/,-]+/).filter((w) => /^[A-Z0-9]/.test(w)).map((w) => w.toLowerCase());

function toolProblem(entry, index, seen) {
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  const id = entry.product_id;
  if (typeof id !== 'string' || !id) return 'product_id is missing';
  if (seen.has(id)) return 'is listed twice';
  const hit = index.get(id);
  if (!hit) return 'is not in the affiliate registry';
  if (hit.state !== 'active') return `its registry row is ${hit.state}, not active`;
  if (hit.row.risk_class !== 'green') return `its registry row is ${hit.row.risk_class}, not green (no pesticide in this email)`;
  if (hit.row.merchant !== 'amazon') return 'its registry row is not an Amazon product';
  if (!AMAZON_URL.test(String(hit.row.approved_affiliate_url))) return 'its registry URL is not a tagged Amazon product page';
  const { name } = entry;
  if (typeof name !== 'string' || !NAME.test(name) || bannedReason(name)) return 'name must be a plain generic name in sentence case ("Rain gauge")';
  const brands = brandWords(hit.row.display_name);
  const brand = name.toLowerCase().split(' ').find((w) => brands.includes(w));
  if (brand) return `name uses the brand word "${brand}"`;
  if (!Array.isArray(entry.lines) || entry.lines.length < 1 || entry.lines.length > 2) return 'needs 1 or 2 lines';
  for (const line of entry.lines) {
    if (typeof line !== 'string' || !line.trim() || line !== line.trim() || /[\r\n]/.test(line)) return 'each line must be one trimmed line of text';
    const reason = toolLineProblem(line, { name });
    if (reason) return `line "${line}": ${reason}`;
  }
  if (!Array.isArray(entry.services) || !entry.services.length || entry.services.some((s) => !SERVICES.has(s))) {
    return 'services must list fact-bank services';
  }
  return null;
}

/**
 * @param {{ tools: object[] }} raw  the tools file
 * @param {Map<string, { row: object, state: string }>} [index]  registry.productIndex()
 * @returns {ReadonlyArray<{ productId: string, name: string, lines: string[], services: string[], url: string }>}
 */
function validateTools(raw, index = registry.productIndex()) {
  if (!raw || !Array.isArray(raw.tools)) throw new Error('pest-insider tools: the file has no tools list');
  const seen = new Set();
  return Object.freeze(raw.tools.map((entry) => {
    const problem = toolProblem(entry, index, seen);
    if (problem) throw new Error(`pest-insider tools: ${(entry && entry.product_id) || '(no product_id)'}: ${problem}`);
    seen.add(entry.product_id);
    return Object.freeze({
      productId: entry.product_id,
      name: entry.name,
      lines: Object.freeze([...entry.lines]),
      services: Object.freeze([...entry.services]),
      url: index.get(entry.product_id).row.approved_affiliate_url,
    });
  }));
}

const TOOLS = validateTools(data);

/** A tool by its product id, or null. */
const toolById = (productId) => TOOLS.find((t) => t.productId === productId) || null;

/** Every reviewed tool link; the renderer and the send validator accept no other. A frozen array. */
const TOOL_URLS = Object.freeze(TOOLS.map((t) => t.url));

/** The tool's link text: its generic name, then where it is sold. */
const toolLinkText = (tool) => `${tool.name} on Amazon`;

module.exports = { TOOLS, TOOL_URLS, AMAZON_DISCLOSURE, toolById, toolLinkText, validateTools };
