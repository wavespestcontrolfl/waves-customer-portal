/**
 * Browser form-filler — fills + submits a business-listing/citation form with
 * Playwright + Claude vision, FAIL-CLOSED on anything that isn't a free, no-login
 * submission. Adapted from the (dead) backlink-agent signup-worker's proven
 * screenshot→action-plan→execute loop, repointed at NAP citation forms.
 *
 * It NEVER bypasses a CAPTCHA, creates an account, or pays — it detects those and
 * returns a blocked_* outcome for the operator/Phase 2. Page content is untrusted:
 * the model only emits a constrained action plan; unexpected output → fail (never
 * an open-ended agent action).
 *
 * SSRF model (server-side browser on an untrusted page): a separate in-JS DNS
 * preflight CANNOT stop Chromium re-resolving to a private IP (rebinding), so this
 * does TWO things instead — (1) PIN Chromium's DNS for the allowlisted host to a
 * pre-verified PUBLIC IP via --host-resolver-rules, so the browser connects to the IP
 * we checked (no second lookup), and (2) ABORT every request to any other host at the
 * route layer BEFORE it connects (no off-host sub-resources → no JS exfiltration). The
 * browser therefore only ever contacts the one verified-public pinned host.
 *   DEPLOYMENT PREREQUISITE: before GATE_SIGNUP_RUNNER is enabled in prod, the Railway
 *   service running this MUST also have an egress firewall blocking RFC1918 / 169.254 /
 *   ::1 / fc00::/7 — the network-layer backstop for any residual. The runner is gated
 *   OFF + allowlist-supervised until that is in place.
 *
 * Injectable (launchBrowser, anthropic, resolveHostIps) so the orchestration is
 * unit-testable without a real browser/DNS. Returns { outcome, liveUrl, screenshot,
 * errorCode, notes }.
 */

const dns = require('dns');
const net = require('net');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { _internals: ssrf } = require('./contact-finder'); // isBlockedHostname + isPrivateIp

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// A host is "on the allowlisted domain" if it equals it or is a sub-domain of it
// (a directory may host the live listing / confirmation on a sub-domain). Same
// registrable domain only — never an off-domain host. Used for what we STORE/verify
// (live_url, redirect sanity); the browser EGRESS guard below is stricter still.
function hostMatchesExpected(host, expected) {
  return !!expected && (host === expected || host.endsWith(`.${expected}`));
}

/**
 * Egress decision for the Playwright route guard. The browser may ONLY contact the
 * pinned allowlisted host (apex or its www, which we pin to the same verified public
 * IP); EVERY other request — off-host sub-resource, redirect, or a non-www sub-domain
 * we didn't pin — is aborted BEFORE it connects, so nothing unpinned is ever resolved
 * and there is no off-host channel to exfiltrate through. Synchronous (no DNS): the
 * private-IP safety comes from pinning + the deployment egress firewall, not a lookup.
 */
function requestAllowed({ url, expectedHost }) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!host || ssrf.isBlockedHostname(host)) return false;
  return !!expectedHost && hostOf(url) === expectedHost; // apex/www of the pinned host only
}

/**
 * Resolve a host to its PUBLIC IPs for DNS-pinning. Fail-closed: returns [] if the
 * host doesn't resolve or ANY returned address is private/internal (so we never pin —
 * and therefore never launch a browser against — a host that resolves to an internal
 * address). An IP literal is returned only if it is itself public.
 */
async function resolvePublicIps(host) {
  if (!host) return [];
  if (net.isIP(host)) return ssrf.isPrivateIp(host) ? [] : [host];
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { return []; }
  if (!addrs.length || addrs.some((a) => ssrf.isPrivateIp(a.address))) return [];
  return [...new Set(addrs.map((a) => a.address))];
}

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = process.env.MODEL_SIGNUP_FILLER || MODELS.FLAGSHIP; // vision + reasoning; no temperature needed
const NAV_TIMEOUT = 30000;
// NO 'click': arbitrary clicks can submit a form early (then we'd report failed and
// retry → duplicate listing). Citation forms need only fill/select/check + the single
// final 'submit'. Also NOT 'upload' (no file/account), NOT captcha bypass.
const ALLOWED_ACTIONS = new Set(['fill', 'select', 'check', 'submit']);

function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

// hostResolverRules pins Chromium's DNS to a pre-verified public IP so it can't
// re-resolve the allowlisted host to a private address mid-run (rebinding).
const defaultLaunch = ({ hostResolverRules } = {}) => chromium.launch({
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    ...(hostResolverRules ? [`--host-resolver-rules=${hostResolverRules}`] : []),
  ],
});

function planPrompt(nap) {
  const a = nap.address || {};
  return `You are filling a LOCAL BUSINESS "add your listing / submit business" form. Look at the screenshot.

FIRST decide if this is a FREE, no-login submission we can complete now. Set "blocked":
- "account"  → it requires signing in / creating an account before submitting
- "captcha"  → a CAPTCHA / "I'm not a robot" / hCaptcha / reCAPTCHA is present
- "payment"  → submitting requires payment / a paid plan
- "phone"    → it requires phone/SMS verification
- null       → a plain free form we can fill and submit right now
If "form_present" is false, there's no submittable business form on this page.

If (and only if) blocked is null and form_present is true, return an ordered "actions" list filling ALL visible fields with this business's data — NEVER invent values, use only what's given:
- Business name: ${nap.business_name}
- Website: ${nap.website}
- Email: ${nap.email}
- Phone: ${nap.phone}
- Address: ${a.street || ''}, ${a.city || ''}, ${a.state || ''} ${a.zip || ''}
- Category: ${nap.category}
- Description: ${nap.description}

Return ONLY JSON (no markdown):
{"form_present":bool,"blocked":null|"account"|"captcha"|"payment"|"phone",
 "actions":[{"action":"fill|select|check","selector":"CSS","value":"..."},{"action":"submit","selector":"CSS"}],
 "notes":"≤15 words"}
Rules: robust selectors (input[name=...]/#id over classes); use ONLY fill/select/check then end with exactly one "submit" as the final action; do NOT emit "click" (the final submit is the only button press), file uploads, or any CAPTCHA step. If completing the listing needs a multi-step wizard, an account, or a button that isn't the final submit, set form_present:false.`;
}

async function callVision(anthropic, screenshotB64, text) {
  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
      { type: 'text', text },
    ] }],
  });
  return parseJson((resp.content || []).map((b) => b.text || '').join(''));
}

/**
 * fillCitationForm — submit one free citation form. Returns a structured outcome;
 * never throws (engine errors → { outcome:'failed' }).
 */
async function fillCitationForm({ submitUrl, nap, expectedHost = null }, { launchBrowser = defaultLaunch, anthropic, resolveHostIps = resolvePublicIps } = {}) {
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client) return { outcome: 'failed', errorCode: 'no_anthropic', notes: 'no LLM client' };
  if (!launchBrowser) return { outcome: 'failed', errorCode: 'no_browser', notes: 'playwright unavailable' };
  // expectedHost is mandatory — the browser is pinned + egress-locked to it.
  if (!expectedHost) return { outcome: 'failed', errorCode: 'no_expected_host', notes: 'expectedHost required (pinned egress)' };

  // Resolve the allowlisted host to a verified PUBLIC IP and PIN Chromium's DNS to it
  // so the browser connects to the address we checked (no rebinding to an internal IP).
  // Fail-closed: if it doesn't resolve public, never launch.
  const ips = await resolveHostIps(expectedHost);
  if (!ips || !ips.length) return { outcome: 'failed', errorCode: 'host_not_public', notes: `${expectedHost} did not resolve to a public IP` };
  const pinnedIp = ips[0];
  const hostResolverRules = `MAP ${expectedHost} ${pinnedIp},MAP www.${expectedHost} ${pinnedIp}`;

  let browser;
  try {
    browser = await launchBrowser({ hostResolverRules });
    const context = await browser.newContext();
    const page = await context.newPage();
    // EGRESS LOCK: the browser may contact ONLY the pinned allowlisted host (apex/www).
    // Every other request — off-host sub-resource, redirect, unpinned sub-domain — is
    // aborted BEFORE it connects, so nothing unpinned is resolved and there is no
    // off-host channel for a hostile page to exfiltrate through or pivot internally.
    if (typeof context.route === 'function') {
      await context.route('**/*', (route) => {
        let ok = false;
        try { ok = requestAllowed({ url: route.request().url(), expectedHost }); } catch { ok = false; }
        return ok ? route.continue() : route.abort();
      });
    }
    await page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Off-host redirect guard: if the page navigated away from the allowlisted host,
    // bail before screenshotting / sending anything to the model.
    if (expectedHost && typeof page.url === 'function' && !hostMatchesExpected(hostOf(page.url()), expectedHost)) {
      return { outcome: 'failed', errorCode: 'offsite_redirect', notes: `redirected off ${expectedHost}` };
    }
    await page.waitForTimeout(1500);

    const shot1 = (await page.screenshot({ fullPage: true, type: 'png' }));
    const plan = await callVision(client, shot1.toString('base64'), planPrompt(nap));
    if (!plan || typeof plan !== 'object') return { outcome: 'failed', errorCode: 'plan_parse', screenshot: shot1, notes: 'no plan' };
    if (plan.blocked) return { outcome: `blocked_${plan.blocked}`.replace('blocked_phone', 'blocked_phone_verification'), errorCode: `blocked_${plan.blocked}`, screenshot: shot1, notes: plan.notes };
    if (plan.form_present !== true || !Array.isArray(plan.actions) || !plan.actions.length) return { outcome: 'skipped', errorCode: 'no_form', screenshot: shot1, notes: plan.notes || 'no form' };

    // Validate the plan SHAPE before touching the page. A partial run that submits via
    // a stray click and only THEN reports no_submit would risk a duplicate listing on
    // the next retry — so require exactly one submit action, as the final action,
    // up front; anything else is rejected without filling anything.
    const submitCount = plan.actions.filter((a) => a && a.action === 'submit').length;
    const last = plan.actions[plan.actions.length - 1];
    if (submitCount !== 1 || !last || last.action !== 'submit' || !last.selector) {
      return { outcome: 'failed', errorCode: 'no_submit', screenshot: shot1, notes: 'plan must end with exactly one submit action' };
    }

    // Execute ONLY the allowlisted, deterministic actions (fill/select/check); any
    // other action the model emitted — click, upload, captcha step — is not in
    // ALLOWED_ACTIONS and is skipped. The single final 'submit' is the only button press.
    let submitted = false;
    for (const act of plan.actions) {
      if (!act || !ALLOWED_ACTIONS.has(act.action) || !act.selector) continue;
      try {
        if (act.action === 'fill') await page.fill(act.selector, String(act.value ?? ''));
        else if (act.action === 'select') await page.selectOption(act.selector, String(act.value ?? ''));
        else if (act.action === 'check') await page.check(act.selector);
        else if (act.action === 'submit') { await page.click(act.selector); submitted = true; await page.waitForLoadState('domcontentloaded').catch(() => {}); }
        await page.waitForTimeout(250 + Math.random() * 500);
      } catch (e) {
        logger.warn(`[form-filler] action ${act.action} ${act.selector} failed: ${e.message}`);
      }
    }
    if (!submitted) return { outcome: 'failed', errorCode: 'no_submit', screenshot: shot1, notes: 'submit action did not run' };

    await page.waitForTimeout(1500);
    const shot2 = (await page.screenshot({ fullPage: true, type: 'png' }));
    const verify = await callVision(client, shot2.toString('base64'),
      'Did the previous business-listing submission SUCCEED? Look for a confirmation/thank-you, a moderation/"pending review" notice, or a created listing URL. Return ONLY JSON: {"success":bool,"pending":bool,"live_url":"url or null","notes":"≤15 words"}');
    // Only trust a returned live_url that is on the allowlisted domain — a citation's
    // listing lives on the directory's own domain. The downstream verifier fetches
    // live_url server-side, so a model-/page-supplied off-host or internal URL must
    // NOT be stored (it would bypass the same-host SSRF guard). Off-host → drop it
    // (the placement reports pending; the verifier's domain reconcile finds the URL).
    const claimedLive = verify && typeof verify.live_url === 'string' && /^https?:\/\//.test(verify.live_url) ? verify.live_url : null;
    const liveUrl = claimedLive && hostMatchesExpected(hostOf(claimedLive), expectedHost) ? claimedLive : null;
    if (verify && (verify.success || verify.pending)) {
      // Pending whenever the model said so OR we have no trusted live URL (incl. one
      // dropped as off-host) — a placement without a confirmed on-host URL must be
      // reported pending so the verifier reconciles it instead of stranding the row.
      return { outcome: 'placed', pending: !!verify.pending || !liveUrl, liveUrl, screenshot: shot2, notes: verify.notes };
    }
    return { outcome: 'failed', errorCode: 'unconfirmed', screenshot: shot2, notes: (verify && verify.notes) || 'submission not confirmed' };
  } catch (err) {
    logger.error(`[form-filler] ${submitUrl}: ${err.message}`);
    return { outcome: 'failed', errorCode: 'engine_error', notes: String(err.message).slice(0, 160) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { fillCitationForm };
module.exports._internals = { parseJson, planPrompt, ALLOWED_ACTIONS, requestAllowed, hostOf, hostMatchesExpected, resolvePublicIps };
