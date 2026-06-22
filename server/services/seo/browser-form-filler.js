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
 * Egress decision for the Playwright route guard. The browser may contact ONLY a host
 * whose EXACT hostname was successfully DNS-pinned to a verified public IP (allowedHosts
 * = the pin set). EVERY other request — off-host sub-resource, redirect, OR an
 * apex/www sibling we couldn't pin — is aborted BEFORE it connects, so Chromium never
 * does its own (rebindable) lookup and there is no off-host exfil channel. Exact-match,
 * never normalized: a host that isn't in the pin set is refused even if it's the same
 * registrable domain (an unpinned sibling would otherwise reopen the rebinding gap).
 */
function requestAllowed({ url, allowedHosts }) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (!host || ssrf.isBlockedHostname(host)) return false;
  return allowedHosts instanceof Set && allowedHosts.has(host);
}

// The plan contract's legal "blocked" values — anything else (omitted/false/'') is a
// malformed/injected plan and must fail closed, not proceed to fill+submit.
const BLOCKED_VALUES = new Set([null, 'account', 'captcha', 'payment', 'phone']);

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

  // PIN Chromium's DNS to verified PUBLIC IPs so it connects to the address we checked
  // (no rebinding to an internal IP). The egress guard allows the apex AND its www, so
  // pin EACH to its OWN resolved public IP (apex and www can be different origins, or
  // only www may have a record) — any allowed-but-unpinned host would let Chromium do
  // its own lookup and reopen the rebinding gap. Fail-closed: the host we actually
  // navigate to MUST resolve public, else never launch.
  const navHost = (() => { try { return new URL(submitUrl).hostname.toLowerCase(); } catch { return expectedHost; } })();
  const rules = [];
  const pinned = new Set();
  for (const h of new Set([expectedHost, `www.${expectedHost}`, navHost])) {
    const hips = await resolveHostIps(h);
    if (!hips || !hips.length) continue; // no public record → not pinned (not a rebinding vector)
    // Prefer IPv4; an IPv6 replacement must be bracketed ([addr]) in --host-resolver-rules.
    const raw = hips.find((ip) => net.isIPv4(ip)) || hips[0];
    rules.push(`MAP ${h} ${net.isIPv6(raw) ? `[${raw}]` : raw}`);
    pinned.add(h);
  }
  if (!pinned.has(navHost)) return { outcome: 'failed', errorCode: 'host_not_public', notes: `${navHost} did not resolve to a public IP` };
  const hostResolverRules = rules.join(',');

  // Track whether the egress guard aborted the actual SUBMIT request (form POST or the
  // post-submit navigation). If it did, nothing landed at the directory — we must NOT
  // report placed (which would strand a row the verifier polls forever).
  let submitPhase = false;
  let submitAborted = false;

  let browser;
  try {
    // A browser launch failure (Playwright/Chromium absent, missing host deps) is a
    // RUN-LEVEL environment error, not this prospect's fault → no_browser so the runner
    // aborts the batch + releases claims rather than burning the prospect's attempts.
    try { browser = await launchBrowser({ hostResolverRules }); }
    catch (e) { return { outcome: 'failed', errorCode: 'no_browser', notes: `browser launch failed (env): ${String(e.message).slice(0, 120)}` }; }
    // serviceWorkers:'block' — context.route() does NOT intercept requests made from a
    // Service Worker, so a registered SW would be an egress hole around the one-host
    // guard. Block SWs so route() is the complete HTTP(S) boundary.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    // EGRESS LOCK (HTTP/S): the browser may contact ONLY the pinned allowlisted host
    // (apex/www). Every other request — off-host sub-resource, redirect, unpinned
    // sub-domain — is aborted BEFORE it connects, so nothing unpinned is resolved and
    // there is no off-host channel for a hostile page to exfiltrate through or pivot.
    if (typeof context.route === 'function') {
      await context.route('**/*', (route) => {
        const req = route.request();
        let ok = false;
        try { ok = requestAllowed({ url: req.url(), allowedHosts: pinned }); } catch { ok = false; }
        if (!ok) {
          // If we abort the SUBMIT itself (form POST or the post-submit navigation to an
          // off-host/unpinned endpoint), record it — the submission did not land.
          try { if (submitPhase && (req.isNavigationRequest() || req.method() === 'POST')) submitAborted = true; } catch { /* noop */ }
          return route.abort();
        }
        return route.continue();
      });
    }
    // EGRESS LOCK (WebSockets): route() doesn't cover WS, which would otherwise be an
    // off-host exfiltration channel. Citation forms never need a socket, so close every
    // WS connection the page tries to open.
    if (typeof context.routeWebSocket === 'function') {
      try { await context.routeWebSocket('**/*', (ws) => { try { ws.close(); } catch { /* noop */ } }); }
      catch (e) { logger.warn(`[form-filler] routeWebSocket setup failed: ${e.message}`); }
    }
    await page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Off-pin redirect guard: if the page landed on a host we did NOT pin (the route
    // guard should already have aborted it), bail before screenshotting / calling the model.
    const landedHost = (() => { try { return new URL(page.url()).hostname.toLowerCase(); } catch { return ''; } })();
    if (typeof page.url === 'function' && !pinned.has(landedHost)) {
      return { outcome: 'failed', errorCode: 'offsite_redirect', notes: `landed off the pinned host: ${landedHost || 'unknown'}` };
    }
    await page.waitForTimeout(1500);

    const shot1 = (await page.screenshot({ fullPage: true, type: 'png' }));
    const plan = await callVision(client, shot1.toString('base64'), planPrompt(nap));
    if (!plan || typeof plan !== 'object') return { outcome: 'failed', errorCode: 'plan_parse', screenshot: shot1, notes: 'no plan' };
    // FAIL-CLOSED full-schema validation BEFORE touching the page. A malformed/injected
    // plan (blocked omitted/false/'' , non-boolean form_present, non-array actions, or an
    // unexpected action type) must NOT slip past the gate checks into fill+submit.
    if (!BLOCKED_VALUES.has(plan.blocked) || typeof plan.form_present !== 'boolean' || !Array.isArray(plan.actions)) {
      return { outcome: 'failed', errorCode: 'plan_invalid', screenshot: shot1, notes: 'malformed plan (blocked/form_present/actions)' };
    }
    if (plan.blocked) return { outcome: `blocked_${plan.blocked}`.replace('blocked_phone', 'blocked_phone_verification'), errorCode: `blocked_${plan.blocked}`, screenshot: shot1, notes: plan.notes };
    if (!plan.form_present || !plan.actions.length) return { outcome: 'skipped', errorCode: 'no_form', screenshot: shot1, notes: plan.notes || 'no form' };
    // Every action must be a known type — an unexpected type (click/upload/etc.) signals
    // a plan we can't faithfully execute, so reject the whole plan rather than submit a
    // form with steps silently dropped.
    if (!plan.actions.every((a) => a && ALLOWED_ACTIONS.has(a.action))) {
      return { outcome: 'failed', errorCode: 'plan_invalid', screenshot: shot1, notes: 'unexpected action type in plan' };
    }

    // Validate the plan SHAPE before touching the page: exactly one submit action, and
    // it must be the FINAL action. We then run actions[0..-2] as fields and the last as
    // the submit, so a malformed plan can't interleave a submit mid-fill or submit twice.
    const submitCount = plan.actions.filter((a) => a && a.action === 'submit').length;
    const last = plan.actions[plan.actions.length - 1];
    if (submitCount !== 1 || !last || last.action !== 'submit' || !last.selector) {
      return { outcome: 'failed', errorCode: 'no_submit', screenshot: shot1, notes: 'plan must end with exactly one submit action' };
    }

    // FAIL-CLOSED: every pre-submit field action must succeed. A failed fill/select/
    // check (missing required NAP field, wrong selector) means an incomplete listing,
    // so we abort BEFORE clicking submit rather than submit a partial form. The single
    // final 'submit' is sliced off and run separately. Non-vocab actions (click/upload)
    // aren't in ALLOWED_ACTIONS and are skipped (never submit early).
    for (const act of plan.actions.slice(0, -1)) {
      if (!act || !ALLOWED_ACTIONS.has(act.action) || act.action === 'submit') continue; // non-vocab (click/upload) or a stray submit → skip
      // A vocab field action (fill/select/check) with NO selector can't be performed —
      // fail closed (abort before submit) rather than silently skip and submit a
      // partially-blank listing.
      if (!act.selector) return { outcome: 'failed', errorCode: 'field_action_failed', screenshot: shot1, notes: `${act.action} action missing selector (not submitted)` };
      try {
        if (act.action === 'fill') await page.fill(act.selector, String(act.value ?? ''));
        else if (act.action === 'select') await page.selectOption(act.selector, String(act.value ?? ''));
        else if (act.action === 'check') await page.check(act.selector);
        await page.waitForTimeout(250 + Math.random() * 500);
      } catch (e) {
        logger.warn(`[form-filler] pre-submit ${act.action} ${act.selector} failed: ${e.message}`);
        return { outcome: 'failed', errorCode: 'field_action_failed', screenshot: shot1, notes: `pre-submit ${act.action} failed (not submitted)` };
      }
    }

    // The submit click is the point of no return. Split ACTIONABILITY (was the button
    // found/enabled — auto-waited before dispatch) from the triggered NAVIGATION
    // (noWaitAfter:true so click() does NOT wait for, and cannot throw on, the POST's
    // redirect being aborted/timing out). So: click() throws ONLY if the button was
    // never actionable → nothing dispatched → genuinely retryable. Once it dispatches
    // (no throw), the POST may have landed — we NEVER auto-retry; any later navigation
    // /verification error becomes placed+pending below.
    submitPhase = true; // requests from here are the submission (POST / nav)
    try {
      await page.click(last.selector, { noWaitAfter: true });
    } catch (e) {
      return { outcome: 'failed', errorCode: 'submit_failed', screenshot: shot1, notes: `submit not actionable (nothing dispatched): ${e.message}` };
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {}); // best-effort settle; never fatal post-dispatch

    // If the egress guard aborted the submit's own POST/navigation, nothing reached the
    // directory — do NOT report placed. The runner parks it (off-host submit endpoint
    // can't be auto-submitted) rather than stranding a row the verifier polls forever.
    if (submitAborted) {
      return { outcome: 'failed', errorCode: 'submit_blocked', screenshot: shot1, notes: 'submit POST/navigation went off the pinned host (aborted) — nothing submitted' };
    }

    // Submit landed → from here ANY error still yields a PENDING placement, never a
    // retryable failure (a retry could duplicate the listing). Verification is
    // best-effort: if the wait/screenshot/model call throws, we still report pending
    // rather than letting it fall to the outer catch (which would report failed).
    let verify = null;
    let shot2 = null;
    try {
      await page.waitForTimeout(1500);
      shot2 = await page.screenshot({ fullPage: true, type: 'png' });
      verify = await callVision(client, shot2.toString('base64'),
        'Did the previous business-listing submission SUCCEED? Look for a confirmation/thank-you, a moderation/"pending review" notice, or a created listing URL. Return ONLY JSON: {"success":bool,"pending":bool,"live_url":"url or null","notes":"≤15 words"}');
    } catch (e) {
      logger.warn(`[form-filler] post-submit verification failed for ${expectedHost} (still reporting pending): ${e.message}`);
    }
    // The submit WAS clicked → ALWAYS report a PENDING placement (never failed/retry,
    // even when the confirmation is unrecognized — a retry could duplicate a listing
    // that actually succeeded). We do NOT store a model-/page-supplied live_url: the
    // verifier fetches live_url server-side following redirects, so an open-redirect or
    // rebinding on the directory could turn it into an SSRF. The verifier's domain
    // reconcile discovers the real URL; the model's claimed URL is kept only as a
    // non-fetched evidence note (and only if it's on the allowlisted domain).
    const claimedLive = verify && typeof verify.live_url === 'string' && /^https?:\/\//.test(verify.live_url) ? verify.live_url : null;
    const onHostClaim = claimedLive && hostMatchesExpected(hostOf(claimedLive), expectedHost) ? claimedLive : null;
    const confirmed = !!(verify && (verify.success || verify.pending));
    const note = [(verify && verify.notes) || (confirmed ? 'submitted' : 'submitted; unconfirmed'), onHostClaim ? `claimed:${onHostClaim}` : ''].filter(Boolean).join(' ').slice(0, 200);
    return { outcome: 'placed', pending: true, liveUrl: null, screenshot: shot2, notes: note };
  } catch (err) {
    logger.error(`[form-filler] ${submitUrl}: ${err.message}`);
    return { outcome: 'failed', errorCode: 'engine_error', notes: String(err.message).slice(0, 160) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { fillCitationForm };
module.exports._internals = { parseJson, planPrompt, ALLOWED_ACTIONS, requestAllowed, hostOf, hostMatchesExpected, resolvePublicIps };
