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
 * Injectable (launchBrowser, anthropic) so the orchestration is unit-testable
 * without a real browser. Returns { outcome, liveUrl, screenshot(Buffer), errorCode, notes }.
 */

const MODELS = require('../../config/models');
const logger = require('../logger');
const { _internals: ssrf } = require('./contact-finder'); // isBlockedHostname (sync) + hostResolvesPublic (DNS)

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// A host is "on the allowlisted domain" if it equals it or is a sub-domain of it
// (a directory may host the live listing / confirmation on a sub-domain). Same
// registrable domain only — never an off-domain host.
function hostMatchesExpected(host, expected) {
  return !!expected && (host === expected || host.endsWith(`.${expected}`));
}

// A selector that looks like a submit control — we never let a model-emitted `click`
// hit one (the real submission goes through the explicit final `submit` action), so a
// stray click can't submit the form early and trigger a duplicate listing on retry.
function isSubmitControl(sel) {
  return /submit/i.test(String(sel || ''));
}

/**
 * Per-request SSRF decision for the Playwright route guard. Applied to EVERY request
 * the browser makes (top-level navigation, redirect, sub-resource). Blocks:
 *  (a) localhost / intranet / private-IP-literal hosts (sync, no DNS),
 *  (b) a top-level navigation that leaves the allowlisted host (we only ever fill +
 *      submit on expectedHost; a hostile redirect off-host is refused), and
 *  (c) any host that resolves to a private/internal IP — closes the DNS-rebinding
 *      gap a one-shot preflight can't (a public-looking host can resolve private).
 * Public off-host SUB-resources (CDN/fonts/analytics) are allowed so the page still
 * renders for the vision model. resolvePublic is injected (cached DNS) for testing.
 */
async function requestAllowed({ url, isNavigation, isTopFrame }, { expectedHost, resolvePublic }) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!host || ssrf.isBlockedHostname(host)) return false;
  if (expectedHost && isNavigation && isTopFrame && !hostMatchesExpected(hostOf(url), expectedHost)) return false;
  if (!(await resolvePublic(host))) return false;
  return true;
}

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = process.env.MODEL_SIGNUP_FILLER || MODELS.FLAGSHIP; // vision + reasoning; no temperature needed
const NAV_TIMEOUT = 30000;
const ALLOWED_ACTIONS = new Set(['fill', 'select', 'check', 'click', 'submit']); // NOT 'upload' (no file/account), NOT captcha bypass

function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

const defaultLaunch = () => chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });

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
 "actions":[{"action":"fill|select|check|click","selector":"CSS","value":"..."},{"action":"submit","selector":"CSS"}],
 "notes":"≤15 words"}
Rules: robust selectors (input[name=...]/#id over classes); do NOT include file uploads; do NOT attempt to bypass a CAPTCHA; end with one "submit".`;
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
async function fillCitationForm({ submitUrl, nap, expectedHost = null }, { launchBrowser = defaultLaunch, anthropic } = {}) {
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client) return { outcome: 'failed', errorCode: 'no_anthropic', notes: 'no LLM client' };
  if (!launchBrowser) return { outcome: 'failed', errorCode: 'no_browser', notes: 'playwright unavailable' };

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    // Defense in depth (the runner host-validates the entry URL): screen EVERY request
    // the browser makes — top-level navigation, redirect, OR sub-resource. Blocks
    // literal-private hosts, top-level navs that leave the allowlisted host, and any
    // host that resolves to a private/internal IP (DNS-rebinding guard the one-shot
    // preflight can't catch). A hostile allowlisted page therefore can't pivot the
    // Railway browser to internal/metadata targets. DNS results cached per host/run.
    if (typeof context.route === 'function') {
      const publicCache = new Map();
      const resolvePublic = async (h) => {
        if (!publicCache.has(h)) publicCache.set(h, await ssrf.hostResolvesPublic(h));
        return publicCache.get(h);
      };
      await context.route('**/*', async (route) => {
        const req = route.request();
        let allowed = false;
        try {
          allowed = await requestAllowed(
            { url: req.url(), isNavigation: req.isNavigationRequest(), isTopFrame: !req.frame().parentFrame() },
            { expectedHost, resolvePublic },
          );
        } catch { allowed = false; }
        return allowed ? route.continue() : route.abort();
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

    // Execute ONLY the allowlisted, deterministic actions; ignore anything else the
    // model emitted (no uploads, no open-ended navigation, no captcha steps). Skip a
    // `click` on a submit-looking control so nothing submits before the final submit.
    let submitted = false;
    for (const act of plan.actions) {
      if (!act || !ALLOWED_ACTIONS.has(act.action) || !act.selector) continue;
      if (act.action === 'click' && isSubmitControl(act.selector)) { logger.warn(`[form-filler] skipping click on submit-like control ${act.selector}`); continue; }
      try {
        if (act.action === 'fill') await page.fill(act.selector, String(act.value ?? ''));
        else if (act.action === 'select') await page.selectOption(act.selector, String(act.value ?? ''));
        else if (act.action === 'check') await page.check(act.selector);
        else if (act.action === 'click') await page.click(act.selector);
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
module.exports._internals = { parseJson, planPrompt, ALLOWED_ACTIONS, requestAllowed, hostOf, hostMatchesExpected, isSubmitControl };
