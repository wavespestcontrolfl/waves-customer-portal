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
 * Is `ip` a GLOBAL-UNICAST (publicly-routable) address? We pin/allow ONLY these —
 * an allowlist stance, not merely "not RFC1918". Rejects every IANA special-use range
 * (private, loopback, link-local, CGNAT, benchmark 198.18/15, the TEST-NETs, protocol-
 * assignment 192.0.0/24, multicast, reserved/broadcast; IPv6 ULA/link-local/multicast/
 * unspecified/doc) so a malicious directory DNS record can't point the browser at
 * special-use infrastructure that routes internally. Builds on ssrf.isPrivateIp.
 */
function isGloballyRoutable(ip) {
  if (net.isIPv4(ip)) {
    if (ssrf.isPrivateIp(ip)) return false; // 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;     // 192.0.0/24 (IETF), 192.0.2/24 (TEST-NET-1)
    if (a === 198 && (b === 18 || b === 19)) return false;              // 198.18/15 (benchmark)
    if (a === 198 && b === 51 && c === 100) return false;              // 198.51.100/24 (TEST-NET-2)
    if (a === 203 && b === 0 && c === 113) return false;               // 203.0.113/24 (TEST-NET-3)
    if (a === 192 && b === 88 && c === 99) return false;               // 192.88.99/24 (6to4 relay anycast, deprecated)
    if (a >= 224) return false;                                        // 224/4 multicast + 240/4 reserved + 255.255.255.255
    return true;
  }
  if (net.isIPv6(ip)) {
    if (ssrf.isPrivateIp(ip)) return false; // ::1, ::, fc/fd (ULA), fe80::/10 (link-local), v4-mapped private
    const h = ip.toLowerCase();
    if (h.startsWith('ff')) return false;                              // ff00::/8 multicast
    // IPv4-translation / tunneling prefixes EMBED an IPv4 in the v6 address — a hostile
    // AAAA like 64:ff9b::a9fe:a9fe (169.254.169.254) would otherwise pass and pin Chromium
    // at internal/metadata IPv4 in a NAT64/6to4-routed env. Reject them outright.
    if (h.startsWith('64:ff9b:') || h === '64:ff9b::' || h.startsWith('64:ff9b::')) return false; // NAT64 (RFC6052/8215)
    if (h.startsWith('2002:')) return false;                           // 6to4 (RFC3056)
    if (h.startsWith('2001:0:') || h.startsWith('2001:0000:')) return false; // Teredo (RFC4380)
    if (h.startsWith('2001:db8') || h.startsWith('2001:0db8')) return false; // 2001:db8::/32 documentation
    if (h === '::1' || h === '::') return false;
    return true;
  }
  return false;
}

/**
 * Resolve a host to its globally-routable PUBLIC IPs for DNS-pinning. Fail-closed:
 * returns [] if the host doesn't resolve or ANY returned address is not global-unicast
 * (so we never pin — and therefore never launch a browser against — a host that
 * resolves to an internal/special-use address). An IP literal is returned only if it
 * is itself globally routable.
 */
async function resolvePublicIps(host) {
  if (!host) return [];
  if (net.isIP(host)) return isGloballyRoutable(host) ? [host] : [];
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { return []; }
  if (!addrs.length || !addrs.every((a) => isGloballyRoutable(a.address))) return [];
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

  // Submission EVIDENCE tracking (set by the route guard during the submit phase):
  //  - submitDispatched: an ALLOWED submit/navigation request actually reached the
  //    pinned host (POST/PUT/PATCH form post, or a navigation incl. a GET form submit
  //    / confirmation) → positive evidence something landed at the directory.
  //  - submitAborted: a submit/navigation request went OFF the pinned host and was
  //    aborted → that attempt reached nothing.
  // We only take the no-retry placed path on verification OR submitDispatched; with
  // neither we treat it as "nothing submitted" (retryable / parked), so a no-op or
  // off-host submit never strands a row as placed.
  let submitPhase = false;
  let submitAborted = false;
  let submitDispatched = false;

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
        // A "submission request" = a body-bearing method (POST/PUT/PATCH — the form post)
        // OR a navigation (a full-page form submit, incl. a GET-method form, or a
        // confirmation redirect). Sub-resource GETs (css/img/xhr fetches) don't count.
        let isSubmitReq = false;
        try { isSubmitReq = submitPhase && (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method() || 'GET').toUpperCase()) || req.isNavigationRequest()); } catch { isSubmitReq = false; }
        let ok = false;
        try { ok = requestAllowed({ url: req.url(), allowedHosts: pinned }); } catch { ok = false; }
        if (!ok) {
          if (isSubmitReq) submitAborted = true;   // a submit/nav attempt went off-host → reached nothing
          return route.abort();
        }
        if (isSubmitReq) submitDispatched = true;  // a submit/nav request reached the pinned host → evidence
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
    let plan;
    try {
      plan = await callVision(client, shot1.toString('base64'), planPrompt(nap));
    } catch (e) {
      // The planning LLM call failed BEFORE any form interaction (timeout/5xx/outage/bad
      // model override) — environmental, not this prospect's fault. RUN-LEVEL so the
      // runner aborts the batch + releases rather than burning the prospect's attempts.
      return { outcome: 'failed', errorCode: 'llm_error', screenshot: shot1, notes: `planning call failed: ${String(e.message).slice(0, 120)}` };
    }
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

    // Verification is best-effort (its own try/catch — a throw here must NOT fall to the
    // outer catch's retryable engine_error). The verifier also reports a clear REJECTION
    // (validation error / required-field / login-CAPTCHA-payment wall) distinctly from
    // a merely-unrecognized confirmation.
    let verify = null;
    let shot2 = null;
    try {
      await page.waitForTimeout(1500);
      shot2 = await page.screenshot({ fullPage: true, type: 'png' });
      verify = await callVision(client, shot2.toString('base64'),
        'Did the previous business-listing submission SUCCEED? success=a confirmation/thank-you or a moderation/"pending review" notice; rejected=a clear error/rejection OR a next-step gate that wasn\'t completed (validation error, "required field", a login/CAPTCHA/payment wall, a phone/SMS verification step, "try again"). Return ONLY JSON: {"success":bool,"pending":bool,"rejected":bool,"live_url":"url or null","notes":"≤15 words"}');
    } catch (e) {
      logger.warn(`[form-filler] post-submit verification failed for ${expectedHost}: ${e.message}`);
    }
    // We NEVER store a model-/page-supplied live_url (the verifier fetches it server-side
    // following redirects → SSRF risk); the verifier's domain reconcile finds the real
    // URL. Keep the model's claimed URL only as a non-fetched, on-host evidence note.
    const claimedLive = verify && typeof verify.live_url === 'string' && /^https?:\/\//.test(verify.live_url) ? verify.live_url : null;
    const onHostClaim = claimedLive && hostMatchesExpected(hostOf(claimedLive), expectedHost) ? claimedLive : null;
    // STRICT booleans only — the verifier output is LLM/page-influenced, so a string
    // "false"/"true" must NOT be truthy-coerced into a confirmation. Anything that isn't
    // exactly `true` is treated as not-that-state (→ falls through to the evidence path).
    const confirmed = !!verify && (verify.success === true || verify.pending === true);
    const rejected = !confirmed && !!verify && verify.rejected === true;
    const placed = (msg) => ({ outcome: 'placed', pending: true, liveUrl: null, screenshot: shot2 || shot1, notes: [(verify && verify.notes) || msg, onHostClaim ? `claimed:${onHostClaim}` : ''].filter(Boolean).join(' ').slice(0, 200) });

    // EVIDENCE-based outcome (not "a click happened"). placed (no-retry → no dup) ONLY
    // when the verifier confirmed OR a submit/nav request actually reached the pinned
    // host. A clear rejection, an off-host (nothing-sent) submit, or no observed
    // submission at all → NOT placed (so the verifier never polls a phantom listing).
    if (confirmed) return placed('submitted');
    if (rejected) return { outcome: 'failed', errorCode: 'submit_rejected', screenshot: shot2 || shot1, notes: (verify && verify.notes) || 'directory rejected the submission' };
    if (submitDispatched) return placed('submitted; unconfirmed (request reached host)');
    if (submitAborted) return { outcome: 'failed', errorCode: 'submit_blocked', screenshot: shot2 || shot1, notes: 'submit request went off the pinned host (aborted) — nothing submitted' };
    return { outcome: 'failed', errorCode: 'no_submit_evidence', screenshot: shot2 || shot1, notes: 'submit clicked but no submission request observed and unconfirmed' };
  } catch (err) {
    logger.error(`[form-filler] ${submitUrl}: ${err.message}`);
    return { outcome: 'failed', errorCode: 'engine_error', notes: String(err.message).slice(0, 160) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { fillCitationForm };
module.exports._internals = { parseJson, planPrompt, ALLOWED_ACTIONS, requestAllowed, hostOf, hostMatchesExpected, resolvePublicIps };
