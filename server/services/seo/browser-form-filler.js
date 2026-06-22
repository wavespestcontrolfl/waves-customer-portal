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
async function fillCitationForm({ submitUrl, nap }, { launchBrowser = defaultLaunch, anthropic } = {}) {
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client) return { outcome: 'failed', errorCode: 'no_anthropic', notes: 'no LLM client' };
  if (!launchBrowser) return { outcome: 'failed', errorCode: 'no_browser', notes: 'playwright unavailable' };

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);

    const shot1 = (await page.screenshot({ fullPage: true, type: 'png' }));
    const plan = await callVision(client, shot1.toString('base64'), planPrompt(nap));
    if (!plan || typeof plan !== 'object') return { outcome: 'failed', errorCode: 'plan_parse', screenshot: shot1, notes: 'no plan' };
    if (plan.blocked) return { outcome: `blocked_${plan.blocked}`.replace('blocked_phone', 'blocked_phone_verification'), errorCode: `blocked_${plan.blocked}`, screenshot: shot1, notes: plan.notes };
    if (!plan.form_present || !Array.isArray(plan.actions) || !plan.actions.length) return { outcome: 'skipped', errorCode: 'no_form', screenshot: shot1, notes: plan.notes || 'no form' };

    // Execute ONLY the allowlisted, deterministic actions; ignore anything else
    // the model emitted (no uploads, no open-ended navigation, no captcha steps).
    let submitted = false;
    for (const act of plan.actions) {
      if (!act || !ALLOWED_ACTIONS.has(act.action) || !act.selector) continue;
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
    if (!submitted) return { outcome: 'failed', errorCode: 'no_submit', screenshot: shot1, notes: 'plan had no submit' };

    await page.waitForTimeout(1500);
    const shot2 = (await page.screenshot({ fullPage: true, type: 'png' }));
    const verify = await callVision(client, shot2.toString('base64'),
      'Did the previous business-listing submission SUCCEED? Look for a confirmation/thank-you, a moderation/"pending review" notice, or a created listing URL. Return ONLY JSON: {"success":bool,"pending":bool,"live_url":"url or null","notes":"≤15 words"}');
    const liveUrl = verify && typeof verify.live_url === 'string' && /^https?:\/\//.test(verify.live_url) ? verify.live_url : null;
    if (verify && (verify.success || verify.pending)) {
      return { outcome: 'placed', pending: !!verify.pending && !liveUrl, liveUrl, screenshot: shot2, notes: verify.notes };
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
module.exports._internals = { parseJson, planPrompt, ALLOWED_ACTIONS };
