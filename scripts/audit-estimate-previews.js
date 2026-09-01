#!/usr/bin/env node
'use strict';

// READ-ONLY against application state. Renders fictional dev-preview fixtures
// and writes screenshots/PDFs only to the requested artifact directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ALL_SCENARIOS = [
  'pest', 'lawn', 'mosquito', 'tree_shrub', 'termite_bait', 'rodent',
  'wdo', 'termite_foam', 'bora_care', 'trap_only', 'bundle', 'commercial',
  'quote_required', 'bundle_referral', 'lawn_member_upgrade', 'accepted',
  'expired', 'missing_contact', 'long_content', 'proposal', 'proposal_terms',
  'proposal_structured', 'proposal_programs', 'preslab',
];
const requestedScenarios = String(process.env.ESTIMATE_PREVIEW_SCENARIOS || '').split(',').map((value) => value.trim()).filter(Boolean);
const unknownScenarios = requestedScenarios.filter((scenario) => !ALL_SCENARIOS.includes(scenario));
if (unknownScenarios.length) {
  throw new Error(`Unknown estimate preview scenario(s): ${unknownScenarios.join(', ')}`);
}
const SCENARIOS = requestedScenarios.length ? ALL_SCENARIOS.filter((scenario) => requestedScenarios.includes(scenario)) : ALL_SCENARIOS;
if (!SCENARIOS.length) throw new Error('No estimate preview scenarios selected');
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } };
const baseUrl = process.env.ESTIMATE_PREVIEW_BASE_URL || 'http://127.0.0.1:4178';
const artifactDir = process.env.ESTIMATE_PREVIEW_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'waves-estimate-audit-'));
fs.mkdirSync(artifactDir, { recursive: true });

const failures = [];
const observations = [];
const fail = (scenario, viewport, message) => failures.push({ scenario, viewport, message });

async function previewServerAvailable() {
  try {
    const response = await fetch(`${baseUrl}/preview-estimate.html`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensurePreviewServer() {
  if (await previewServerAvailable()) return null;
  if (process.env.ESTIMATE_PREVIEW_BASE_URL) {
    throw new Error(`Estimate preview server is unavailable at ${baseUrl}`);
  }

  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['--prefix', 'client', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '4178'],
    { stdio: 'inherit' },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Estimate preview server exited with code ${child.exitCode}`);
    if (await previewServerAvailable()) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for estimate preview server at ${baseUrl}`);
}

async function revealWholePage(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.75));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(100);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const configured = process.env.PLAYWRIGHT_CHROME_PATH;
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = configured || (fs.existsSync(macChrome) ? macChrome : null);
    if (!executablePath) throw error;
    return chromium.launch({ headless: true, executablePath });
  }
}

(async () => {
  let previewServer = null;
  let browser = null;
  try {
    previewServer = await ensurePreviewServer();
    browser = await launchBrowser();
    for (const scenario of SCENARIOS) {
      for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
        const page = await browser.newPage({ viewport });
        const runtimeErrors = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        const url = `${baseUrl}/preview-estimate.html?scenario=${scenario}&chrome=0`;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15000 });
        // Full-page screenshots do not keep every below-fold IntersectionObserver
        // target intersecting at capture time. Force the already-rendered cards
        // visible for the audit artifact; production behavior is unchanged.
        await page.addStyleTag({ content: 'html[data-glass-theme] [data-glass].glass-reveal-pending{opacity:1!important;transform:none!important}' });
        await revealWholePage(page);

        if (!response?.ok()) fail(scenario, viewportName, `HTTP ${response?.status() || 'no response'}`);
        runtimeErrors.forEach((message) => fail(scenario, viewportName, `page error: ${message}`));

        const audit = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          const root = document.documentElement;
          const clippedText = [...document.querySelectorAll('h1,h2,h3,p,a,button,strong,[data-gt]')]
            .filter((el) => {
              const style = getComputedStyle(el);
              const clips = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflow);
              return clips && el.scrollWidth > el.clientWidth + 2 && String(el.textContent || '').trim();
            })
            .slice(0, 8)
            .map((el) => String(el.textContent || '').trim().slice(0, 120));
          const overflowElements = [...document.querySelectorAll('body *')]
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && (rect.right > window.innerWidth + 2 || rect.left < -2))
            .slice(0, 8)
            .map(({ el, rect }) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().replace(/\s+/g, '.')}` : ''} [${Math.round(rect.left)},${Math.round(rect.right)}]`);
          return {
            h1: document.querySelector('h1')?.textContent?.trim() || '',
            bodyText,
            horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
            clippedText,
            overflowElements,
            buttons: [...document.querySelectorAll('button,a')].map((el) => el.textContent.trim()).filter(Boolean),
          };
        });
        if (!audit.h1) fail(scenario, viewportName, 'missing customer-facing H1');
        if (audit.horizontalOverflow > 2) fail(scenario, viewportName, `document overflows horizontally by ${audit.horizontalOverflow}px: ${audit.overflowElements.join(' | ')}`);
        if (audit.clippedText.length) fail(scenario, viewportName, `clipped text: ${audit.clippedText.join(' | ')}`);
        if (/\b(?:pet|kid|child)[^\n.?!]{0,40}\bsafe\b|\bsafe\b[^\n.?!]{0,40}\b(?:pet|kid|child)/i.test(audit.bodyText)) fail(scenario, viewportName, 'blanket pet/child safety wording is visible');
        if (/\b(?:wdo_inspection|termite_foam|trap_only_retainer)\b/.test(audit.bodyText)) fail(scenario, viewportName, 'internal service key is visible');
        if (['wdo', 'preslab'].includes(scenario) && /Waves AI reviewed|Ask Waves|prepared for the property shown/i.test(audit.bodyText)) {
          fail(scenario, viewportName, `${scenario} incorrectly renders AI narrative or an ask bar`);
        }

        observations.push({ scenario, viewport: viewportName, h1: audit.h1, actions: audit.buttons.slice(0, 8) });
        await page.screenshot({ path: path.join(artifactDir, `${scenario}-${viewportName}.png`), fullPage: true });
        await page.close();
      }

      const printPage = await browser.newPage({ viewport: VIEWPORTS.desktop });
      const printUrl = `${baseUrl}/preview-estimate.html?scenario=${scenario}&chrome=0&mode=pdf`;
      await printPage.goto(printUrl, { waitUntil: 'domcontentloaded' });
      await printPage.locator('body').waitFor({ state: 'visible', timeout: 15000 });
      await printPage.waitForTimeout(150);
      await printPage.emulateMedia({ media: 'print' });
      await printPage.pdf({ path: path.join(artifactDir, `${scenario}-print.pdf`), format: 'Letter', printBackground: true, margin: { top: '0.35in', right: '0.35in', bottom: '0.35in', left: '0.35in' } });
      await printPage.close();
    }
  } finally {
    await browser?.close();
    previewServer?.kill('SIGTERM');
  }

  const result = { artifactDir, scenarios: SCENARIOS.length, renderedPages: observations.length, failures, observations };
  fs.writeFileSync(path.join(artifactDir, 'audit.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
