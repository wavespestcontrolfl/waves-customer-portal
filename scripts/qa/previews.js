#!/usr/bin/env node
'use strict';
/* global document, window */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');

const root = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.QA_ARTIFACT_DIR || path.join(root, '.tmp/qa/previews'));
const scenarios = [
  { name: 'portal', url: '/preview-portal.html', ready: 'Jordan' },
  { name: 'portal-cancelled', url: '/preview-portal.html?persona=cancelled', ready: 'cancelled' },
  { name: 'secure-pest', url: '/preview-secure.html?v=pest', ready: 'Quarterly Pest Control' },
  { name: 'secure-lawn', url: '/preview-secure.html?v=lawn', ready: 'Lawn Care' },
  { name: 'service-report', url: '/preview-service-report.html', ready: 'Quarterly Pest Control' },
  { name: 'completion', url: '/preview-completion-presets.html', ready: 'Completion' },
];
const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };

async function checkScenario(browser, baseUrl, scenario, viewportName, viewport) {
  const key = `${scenario.name}-${viewportName}`;
  const context = await browser.newContext({ viewport, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    // Fixtures must not fall through to a real API or external integration.
    if (url.origin !== baseUrl || url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  let failure = null;
  const cleanupErrors = [];
  try {
    const response = await page.goto(baseUrl + scenario.url, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    await page.waitForFunction((text) => document.body.innerText.toLowerCase().includes(text.toLowerCase()), scenario.ready, { timeout: 30000 });
    await waitForFonts(page);
    if (scenario.name === 'service-report') {
      await page.locator('h1.sr-title').waitFor();
      assert.equal(await page.locator('h1.sr-title').innerText(), 'Hi Test, one area could not be serviced!');
      await page.getByText('Side Yard was marked skipped.', { exact: true }).waitFor();
    }
    if (scenario.name === 'completion') {
      for (const preset of ['fire_ant', 'tick_control', 'bee_wasp_removal', 'mud_dauber_removal', 'bed_bug_treatment', 'mosquito', 'dethatching', 'plugging']) {
        await page.selectOption('#preset', preset);
        assert.ok(await page.locator('[id^="preview-"]').count() >= 2, `${preset}: missing finding controls`);
      }
      await page.selectOption('#preset', 'bee_wasp_removal');
      await page.selectOption('#preview-stinging_insect_identification', 'Yellowjacket');
      await page.selectOption('#protocol', 'Exposed nest treated');
      await page.selectOption('#protocol', 'Nest physically removed');
      const text = await page.locator('main').innerText();
      assert.ok(text.includes('[Found] Yellowjacket') && text.includes('[Protocol] Nest physically removed'));
    }
    await page.screenshot({ path: path.join(artifactDir, `${key}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 2, `Horizontal overflow: ${overflow}px`);
    assert.deepEqual(errors, [], 'Browser runtime errors');
  } catch (error) {
    failure = error.message;
    await page.screenshot({ path: path.join(artifactDir, `${key}-failed.png`), fullPage: true }).catch(() => {});
  } finally {
    await context.tracing.stop({ path: path.join(artifactDir, `${key}.zip`) })
      .catch((error) => cleanupErrors.push(`Trace: ${error.message}`));
    await context.close().catch((error) => cleanupErrors.push(`Context: ${error.message}`));
  }
  failure ??= cleanupErrors[0] ?? null;
  return { scenario: scenario.name, viewport: viewportName, passed: !failure, failure, errors, cleanupErrors };
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const report = { provenance: evidence(root), scenarios: [] };
  let server;
  let browser;
  try {
    server = await previewServer(root, process.env.QA_BASE_URL);
    browser = await launchBrowser();
    for (const scenario of scenarios) {
      for (const [name, viewport] of Object.entries(viewports)) {
        const result = await checkScenario(browser, server.baseUrl, scenario, name, viewport);
        report.scenarios.push(result);
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${scenario.name}/${name}${result.failure ? `: ${result.failure}` : ''}`);
      }
    }
    if (report.scenarios.some((item) => !item.passed)) process.exitCode = 1;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    await browser?.close();
    await server?.close();
    fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`QA artifacts: ${artifactDir}`);
  }
})();
