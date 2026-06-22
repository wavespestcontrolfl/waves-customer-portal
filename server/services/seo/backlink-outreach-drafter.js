/**
 * Backlink outreach drafter — the in-repo replacement for the (never-deployed)
 * external Hermes outreach skill. Claims outreach-type link prospects, drafts a
 * personalized 1:1 pitch with Claude, and parks it as a DRAFT (outreach_status=
 * 'drafted') for the operator's one-click approval in the Link Building UI.
 *
 * It NEVER sends — the approval-gated Gmail valve (link-prospect-outreach.js) plus
 * a human do that. It reuses the existing claim/report contract IN-PROCESS
 * (link-prospect-worker.js): no HTTP, no service token, no Hermes deployment.
 *
 * Gated by `outreachDrafter` (GATE_OUTREACH_DRAFTER) at the cron; run() itself is
 * the mechanism (the manual CLI runs it on demand). Drafting playbook adapted from
 * docs/hermes/waves-outreach-drafter-skill.md.
 */

const MODELS = require('../../config/models');
const logger = require('../logger');
const worker = require('./link-prospect-worker');
const { fetchPageText } = require('./contact-finder');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const DRAFT_MODEL = process.env.MODEL_OUTREACH_DRAFTER || MODELS.WORKHORSE;

const SYSTEM_PROMPT = `You are the outreach drafter for Waves Pest Control & Lawn Care (family-owned, SW Florida — Manatee/Sarasota/Charlotte counties). Write ONE short, personalized, one-to-one backlink-outreach email for a single prospect. A human reviews every draft before any send.

RULES (mandatory):
- One-to-one, never templated. Reference the specific site/page/audience by name. The email sends from the PRIMARY Waves inbox, so anything templated or spammy risks real-inbox reputation.
- Value-first and SHORT (~120–180 words). Lead with why it helps THEIR readers/clients, not us. Propose the given Waves money page (LINK TO EARN) as a genuine resource.
- Subject: specific, honest, non-spammy. No "RE:" tricks, no ALL CAPS, no clickbait.
- Identify clearly as Waves Pest Control. End EXACTLY with two lines: "— The Waves Pest Control Team" then "{brand} · {city}, FL · {phone}" using the SIGN-OFF DETAILS provided.
- No pricing, no incentives-for-links, no fabricated statistics. If you cite local pest data, attribute it to "Waves' Pest Pressure tracking" (a real local pest-activity dataset).
- Do NOT write a recipient address or a "From:" line — the portal handles those.

ANGLE by tier / link_type:
- Tier 1 (resource/editorial, local partners — realtors/brokerages, property & HOA management, home inspectors, complementary non-competing home services): wedge = WDO/termite inspections are transaction-critical for FL home sales; offer to be the reliable vendor for their "preferred vendors / resources" page. Mutual-referral framing for inspectors & complementary services.
- Tier 2 (editorial/haro, local media): offer a seasonal hook (spring termite swarm, summer mosquito + hurricane surge, fall rodents) backed by Waves' Pest Pressure local data as a citable resource for an upcoming piece.
- link_type resource: ask to be added to their resources/links/preferred-vendors page.
- link_type guest_post: offer one specific, genuinely useful local guest-article idea.

Return ONLY JSON: {"subject": "...", "body": "..."}. The body is plain text with \\n line breaks and ends with the two-line signature.`;

// Pick the office location whose city the prospect targets (so the sign-off phone
// matches the market); else the default location.
function pickLocation(prospect, profile) {
  const hay = `${prospect.target_page || ''} ${prospect.notes || ''} ${prospect.target_domain || ''}`.toLowerCase();
  const locs = profile.locations || [];
  const byCity = locs.find((l) => {
    const city = String(l.name || '').toLowerCase().replace(/,.*$/, '').trim();
    return (city && hay.includes(city)) || (l.id && hay.includes(String(l.id).toLowerCase()));
  });
  return byCity || locs.find((l) => l.id === profile.default_location_id) || locs[0] || null;
}

function parseDraft(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o && o.subject && o.body) return { subject: String(o.subject).trim(), body: String(o.body).trim() };
  } catch { /* fall through */ }
  return null;
}

function buildUserPrompt(prospect, profile, loc, page) {
  const city = loc ? String(loc.name || '').replace(/,.*$/, '').trim() : 'Bradenton';
  return [
    'PROSPECT',
    `- site: ${prospect.target_domain}`,
    `- their page (if known): ${prospect.target_url || '(unknown)'}`,
    `- link_type: ${prospect.link_type} | tier: ${prospect.tier ?? '?'} | priority: ${prospect.priority || '?'}`,
    `- strategist notes: ${prospect.notes || '(none)'}`,
    prospect.anchor_planned ? `- suggested anchor: ${prospect.anchor_planned}` : '',
    page && (page.title || page.snippet) ? `- what their page actually says: ${[page.title, page.snippet].filter(Boolean).join(' — ').slice(0, 500)}` : '',
    '',
    `LINK TO EARN (propose as the resource): ${prospect.target_page}`,
    '',
    'SIGN-OFF DETAILS (use verbatim):',
    `- brand: ${profile.brand}`,
    `- city: ${city}`,
    `- phone: ${loc ? loc.phone : ''}`,
    `- website: ${profile.website}`,
  ].filter(Boolean).join('\n');
}

async function draftOne(prospect, { profile, anthropic, fetchPageFn = fetchPageText }) {
  let page = null;
  try { page = await fetchPageFn(prospect.target_url || `https://${prospect.target_domain}/`); } catch { page = null; }
  const loc = pickLocation(prospect, profile);
  const resp = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(prospect, profile, loc, page) }],
  });
  const text = (resp && resp.content ? resp.content : []).map((b) => b.text || '').join('');
  return parseDraft(text);
}

/**
 * run — claim a batch of outreach prospects (email-bearing only), draft each, park
 * as 'drafted'. dryRun prints without writing. Returns { claimed, drafted, skipped, failed }.
 */
async function run({ batchSize = 10, dryRun = false, anthropic, fetchPageFn } = {}) {
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client) {
    logger.warn('[outreach-drafter] no Anthropic client/key — nothing drafted');
    return { claimed: 0, drafted: 0, skipped: 0, failed: 0, note: 'no_anthropic' };
  }

  const claimed = await worker.claim({ n: batchSize, type: 'outreach', requireContactEmail: true });
  if (!claimed.length) {
    logger.info('[outreach-drafter] no claimable outreach prospects with a contact email');
    return { claimed: 0, drafted: 0, skipped: 0, failed: 0 };
  }
  const profile = worker.businessProfile();
  let drafted = 0, skipped = 0, failed = 0;
  const samples = []; // dry-run previews — returned to the CLI's stdout, NOT logged (email/body are PII)

  for (const p of claimed) {
    const email = p.contact_email;
    if (!email || !worker.isValidEmail(email)) { // defensive — claim already required a contact_email
      if (!dryRun) await worker.report({ prospect_id: p.id, outcome: 'skipped', lease_token: p.lease_token, notes: 'no emailable contact' }).catch(() => {});
      skipped++; continue;
    }
    try {
      const draft = await draftOne(p, { profile, anthropic: client, fetchPageFn });
      if (!draft) {
        if (!dryRun) await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: 'drafter produced no usable draft' }).catch(() => {});
        failed++; continue;
      }
      if (dryRun) {
        // Don't log the recipient or body (PII / verbose) — collect for the CLI to print to stdout.
        logger.info(`[outreach-drafter][dry] drafted ${p.target_domain} (T${p.tier ?? '?'} ${p.link_type})`);
        samples.push({ domain: p.target_domain, tier: p.tier, link_type: p.link_type, to_email: email, subject: draft.subject, body: draft.body });
        drafted++; continue;
      }
      const res = await worker.report({
        prospect_id: p.id, outcome: 'drafted', lease_token: p.lease_token,
        outreach_to_email: email, outreach_subject: draft.subject, outreach_body: draft.body,
        notes: `auto-drafted (tier ${p.tier ?? '?'} ${p.link_type})`,
      });
      if (res && res.ok) { drafted++; } else { failed++; logger.warn(`[outreach-drafter] report rejected for ${p.target_domain}: ${res && res.code}`); }
    } catch (err) {
      logger.error(`[outreach-drafter] error on ${p.target_domain}: ${err.message}`);
      if (!dryRun) await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: `drafter error: ${String(err.message).slice(0, 160)}` }).catch(() => {});
      failed++;
    }
  }

  // Dry-run claimed leases but never reported (which is what releases a lease), so
  // release them now — keeps a preview side-effect-free. Pass {id, lease_token} so
  // we only clear OUR exact lease (never a newer one from a reclaim).
  if (dryRun) await worker.releaseClaims(claimed.map((p) => ({ id: p.id, lease_token: p.lease_token }))).catch(() => {});

  logger.info(`[outreach-drafter] claimed=${claimed.length} drafted=${drafted} skipped=${skipped} failed=${failed}${dryRun ? ' (DRY-RUN)' : ''}`);
  return { claimed: claimed.length, drafted, skipped, failed, ...(dryRun ? { samples } : {}) };
}

module.exports = { run };
module.exports._internals = { parseDraft, pickLocation, buildUserPrompt, draftOne, SYSTEM_PROMPT, DRAFT_MODEL };
