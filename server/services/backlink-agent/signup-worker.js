const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');

// Structured-output contracts for the three screenshot reads (llm/call.js
// jsonSchema). Every call runs on TEXT_POLICIES.highStakes — FLAGSHIP first,
// the OpenAI leg on a miss — instead of a bare Anthropic client with no
// fallback and a blind content[0] read.
const FIND_SIGNUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['has_signup', 'signup_selector', 'signup_url', 'notes'],
  properties: {
    has_signup: { type: 'boolean' },
    signup_selector: { type: ['string', 'null'], description: 'CSS selector for the signup link/button, or null' },
    signup_url: { type: ['string', 'null'], description: 'Direct URL to the signup page if visible, or null' },
    notes: { type: 'string', description: 'Any relevant observations' },
  },
};
const FILL_FORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'selector', 'value', 'file', 'notes'],
        properties: {
          action: { type: 'string', enum: ['fill', 'click', 'select', 'check', 'upload', 'submit', 'captcha_detected'] },
          selector: { type: ['string', 'null'], description: 'CSS selector the action targets; null for captcha_detected' },
          value: { type: ['string', 'null'], description: 'Text to type (fill) or option value (select); otherwise null' },
          file: { type: ['string', 'null'], enum: ['logo', 'screenshot', null], description: 'upload only' },
          notes: { type: ['string', 'null'], description: 'captcha_detected only' },
        },
      },
    },
  },
};
const VERIFY_SIGNUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'needs_email_verification', 'profile_url', 'error_message'],
  properties: {
    success: { type: 'boolean' },
    needs_email_verification: { type: 'boolean' },
    profile_url: { type: ['string', 'null'], description: 'URL to the new profile if visible, or null' },
    error_message: { type: ['string', 'null'], description: 'Any error shown on the page, or null' },
  },
};

// A dispatcher miss (both legs failed or no JSON) aborts the queue item the
// same way the old SDK throw did — the caller's catch marks it failed.
function requireJson(res, step) {
  if (!res?.ok || !res.json) throw new Error(`${step}: LLM unavailable (${res?.reason || 'no_json'})`);
  return res.json;
}

async function submitToOmegaIndexer(domain, urls) {
  const apiKey = process.env.OMEGA_INDEXER_API_KEY;
  if (!apiKey || urls.length === 0) return;

  try {
    const urlString = encodeURIComponent(urls.join('|'));
    const campaignName = encodeURIComponent(`Waves Backlinks - ${domain}`);

    const res = await fetch('https://www.omegaindexer.com/amember/dashboard/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `apikey=${apiKey}&campaignname=${campaignName}&dripfeed=2&urls=${urlString}`,
    });

    const text = await res.text();
    logger.info(`[backlink-agent] Omega Indexer submitted ${urls.length} URL(s) for ${domain}: ${text}`);
  } catch (err) {
    logger.error(`[backlink-agent] Omega Indexer failed for ${domain}: ${err.message}`);
  }
}

const PROFILE = {
  business_name: 'Waves Pest Control',
  website: process.env.BACKLINK_WEBSITE_URL || 'https://wavespestcontrol.com',
  first_name: 'Waves',
  last_name: 'Pest Control',
  email: process.env.BACKLINK_AGENT_EMAIL || 'contact@wavespestcontrol.com',
  phone: '(941) 318-7612',
  bio: 'Family-owned pest control and lawn care serving Southwest Florida. Pest control, lawn care, mosquito control, termite protection, and more.',
  tagline: 'Family-Owned Pest Control & Lawn Care in Southwest Florida',
  location: 'Bradenton, FL',
  category: 'Pest Control',
  // The wp-content paths died with the WordPress → Astro migration —
  // getLogoPath() 404s on them, so every directory signup silently ran
  // without a logo. Point the defaults at live Astro hub assets.
  logoUrl: process.env.BACKLINK_LOGO_URL || 'https://www.wavespestcontrol.com/images/brand/waves-logo.png',
  screenshotUrl: process.env.BACKLINK_SCREENSHOT_URL || 'https://www.wavespestcontrol.com/images/brand/waves-og.png',
  generatePassword() {
    return crypto.randomBytes(12).toString('base64url').slice(0, 16) + '!A1';
  },
};

// Download an image to a temp file for Playwright file uploads
let _cachedLogoPath = null;
async function getLogoPath() {
  if (_cachedLogoPath && fs.existsSync(_cachedLogoPath)) return _cachedLogoPath;
  try {
    const res = await fetch(PROFILE.logoUrl);
    if (!res.ok) throw new Error(`Logo fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = PROFILE.logoUrl.includes('.png') ? '.png' : '.jpg';
    const tmpPath = path.join(os.tmpdir(), `waves-logo${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    _cachedLogoPath = tmpPath;
    logger.info(`[backlink-agent] Logo cached at ${tmpPath}`);
    return tmpPath;
  } catch (err) {
    logger.error(`[backlink-agent] Logo download failed: ${err.message}`);
    return null;
  }
}

let _cachedScreenshotPath = null;
async function getScreenshotPath() {
  if (_cachedScreenshotPath && fs.existsSync(_cachedScreenshotPath)) return _cachedScreenshotPath;
  try {
    const res = await fetch(PROFILE.screenshotUrl);
    if (!res.ok) throw new Error(`Screenshot fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = PROFILE.screenshotUrl.includes('.png') ? '.png' : '.jpg';
    const tmpPath = path.join(os.tmpdir(), `waves-screenshot${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    _cachedScreenshotPath = tmpPath;
    return tmpPath;
  } catch (err) {
    logger.error(`[backlink-agent] Screenshot download failed: ${err.message}`);
    return null;
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

async function processSignup(queueItem) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: { width: 1280 + Math.floor(Math.random() * 100), height: 800 + Math.floor(Math.random() * 100) },
    ...(process.env.PROXY_URL ? { proxy: { server: process.env.PROXY_URL } } : {}),
  });

  const page = await context.newPage();

  try {
    await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'processing', updated_at: new Date() });

    // Step 1: Navigate to the site
    await page.goto(queueItem.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Screenshot and ask Claude to find signup
    const screenshot1 = (await page.screenshot({ fullPage: false, type: 'png' })).toString('base64');

    const findResponse = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      jsonMode: true,
      jsonSchema: FIND_SIGNUP_SCHEMA,
      maxTokens: 1024,
      images: [{ data: screenshot1, mimeType: 'image/png' }],
      text: `You are a web automation agent. Look at this screenshot of ${queueItem.url}.

I need to create an account/profile on this site. Find the signup, register, or create account link/button: report whether one exists, its CSS selector, the direct signup URL if visible, and any relevant observations.`,
    });

    const signupInfo = requireJson(findResponse, 'find signup');

    if (!signupInfo.has_signup) {
      await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'skipped', error_message: signupInfo.notes || 'No signup found', updated_at: new Date() });
      await browser.close();
      return { success: false, reason: 'no_signup' };
    }

    // Step 3: Navigate to signup page
    if (signupInfo.signup_url) {
      await page.goto(signupInfo.signup_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else if (signupInfo.signup_selector) {
      try {
        await page.click(signupInfo.signup_selector);
        await page.waitForLoadState('domcontentloaded');
      } catch {
        await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'failed', error_message: 'Could not click signup link', updated_at: new Date() });
        await browser.close();
        return { success: false, reason: 'click_failed' };
      }
    }
    await page.waitForTimeout(2000);

    // Step 4: Screenshot the form and ask Claude to fill it
    const formScreenshot = (await page.screenshot({ fullPage: true, type: 'png' })).toString('base64');
    const password = PROFILE.generatePassword();

    const fillResponse = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      jsonMode: true,
      jsonSchema: FILL_FORM_SCHEMA,
      maxTokens: 2048,
      images: [{ data: formScreenshot, mimeType: 'image/png' }],
      text: `You are a web automation agent. Look at this signup/registration form.

Fill it out using this profile information:
- Business Name / Display Name: ${PROFILE.business_name}
- First Name: ${PROFILE.first_name}
- Last Name: ${PROFILE.last_name}
- Email: ${PROFILE.email}
- Password: ${password}
- Website/URL: ${PROFILE.website}
- Bio/About: ${PROFILE.bio}
- Tagline / Slogan: ${PROFILE.tagline}
- Location / City: ${PROFILE.location}
- Phone: ${PROFILE.phone}
- Category / Industry: ${PROFILE.category}

For username fields, use: wavespestcontrol (or wavespestcontrol_fl if that seems taken)

List the actions to take, in order, one object per action:
[
  { "action": "fill", "selector": "CSS selector", "value": "text to type" },
  { "action": "click", "selector": "CSS selector" },
  { "action": "select", "selector": "CSS selector", "value": "option value" },
  { "action": "check", "selector": "CSS selector" },
  { "action": "upload", "selector": "CSS selector for file input", "file": "logo" },
  { "action": "upload", "selector": "CSS selector for file input", "file": "screenshot" },
  { "action": "submit", "selector": "CSS selector for submit button" }
]

Important:
- Include ALL visible form fields, even optional ones like bio, website, location, tagline, category
- For any file upload fields (logo, image, screenshot, avatar, photo), use the "upload" action with file: "logo" for logo/avatar fields or file: "screenshot" for screenshot/image fields
- Include checking any "I agree to terms" checkboxes
- End with the submit button click
- Use robust selectors (prefer input[name=...], input[type=...], #id over fragile class selectors)
- If there's a CAPTCHA, set the last action to: { "action": "captcha_detected", "notes": "description" }`,
    });

    const { actions } = requireJson(fillResponse, 'fill form');

    // Step 5: Execute the actions
    let captchaDetected = false;
    for (const action of actions) {
      try {
        switch (action.action) {
          case 'fill':
            await page.fill(action.selector, action.value);
            break;
          case 'click':
            await page.click(action.selector);
            break;
          case 'select':
            await page.selectOption(action.selector, action.value);
            break;
          case 'check':
            await page.check(action.selector);
            break;
          case 'upload': {
            const filePath = action.file === 'screenshot' ? await getScreenshotPath() : await getLogoPath();
            if (filePath) {
              const fileInput = await page.$(action.selector);
              if (fileInput) {
                await fileInput.setInputFiles(filePath);
                logger.info(`[backlink-agent] Uploaded ${action.file} to ${action.selector}`);
              }
            }
            break;
          }
          case 'submit':
            await page.click(action.selector);
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            break;
          case 'captcha_detected':
            captchaDetected = true;
            break;
        }
        await page.waitForTimeout(300 + Math.random() * 700);
      } catch (e) {
        logger.warn(`[backlink-agent] Action failed on ${queueItem.domain}: ${action.action} ${action.selector} — ${e.message}`);
      }
    }

    if (captchaDetected) {
      await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'failed', error_message: 'CAPTCHA detected', updated_at: new Date() });
      await browser.close();
      return { success: false, reason: 'captcha' };
    }

    // Step 6: Verify result
    await page.waitForTimeout(3000);
    const resultScreenshot = (await page.screenshot({ fullPage: false, type: 'png' })).toString('base64');

    const verifyResponse = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      jsonMode: true,
      jsonSchema: VERIFY_SIGNUP_SCHEMA,
      maxTokens: 512,
      images: [{ data: resultScreenshot, mimeType: 'image/png' }],
      text: 'Did the signup/registration succeed? Look at this result page and report whether it succeeded, whether email verification is needed, the new profile URL if visible, and any error shown.',
    });

    const result = requireJson(verifyResponse, 'verify signup');

    if (result.success) {
      await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'signup_complete', updated_at: new Date() });
      await db('backlink_agent_profiles').insert({
        queue_id: queueItem.id,
        site_url: queueItem.url,
        profile_url: result.profile_url,
        username_used: 'wavespestcontrol',
        email_used: PROFILE.email,
        password_used: password,
        backlink_url: PROFILE.website,
      });
      logger.info(`[backlink-agent] Signup complete: ${queueItem.domain}`);

      // Submit to Omega Indexer for fast indexing
      await submitToOmegaIndexer(queueItem.domain, [result.profile_url, queueItem.url].filter(Boolean));

      return { success: true, profileUrl: result.profile_url, needsVerification: result.needs_email_verification };
    } else {
      await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'failed', error_message: result.error_message || 'Signup failed', updated_at: new Date() });
      return { success: false, reason: result.error_message };
    }
  } catch (error) {
    logger.error(`[backlink-agent] Error processing ${queueItem.domain}: ${error.message}`);
    await db('backlink_agent_queue').where({ id: queueItem.id }).update({ status: 'failed', error_message: error.message, updated_at: new Date() });
    return { success: false, reason: error.message };
  } finally {
    await browser.close();
  }
}

async function processQueue(limit = 5) {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('backlinkAgent')) {
    logger.info('[backlink-agent] Gate disabled — skipping queue processing');
    return { processed: 0 };
  }

  const pending = await db('backlink_agent_queue')
    .where({ status: 'pending' })
    .orderBy('created_at', 'asc')
    .limit(limit);

  const results = [];
  for (const item of pending) {
    const result = await processSignup(item);
    results.push({ domain: item.domain, ...result });
    // Random delay between signups: 2-5 minutes
    if (pending.indexOf(item) < pending.length - 1) {
      const delay = 120000 + Math.random() * 180000;
      logger.info(`[backlink-agent] Waiting ${Math.round(delay / 1000)}s before next signup...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return { processed: results.length, results };
}

module.exports = { processSignup, processQueue, PROFILE };
