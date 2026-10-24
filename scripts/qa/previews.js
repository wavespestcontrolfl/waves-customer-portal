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
  { name: 'login', url: '/login', ready: 'Sign in to Waves', verify: verifyLogin },
  { name: 'portal', url: '/preview-portal.html', ready: 'Jordan' },
  { name: 'portal-cancelled', url: '/preview-portal.html?persona=cancelled', ready: 'cancelled' },
  { name: 'secure-pest', url: '/preview-secure.html?v=pest', ready: 'Quarterly Pest Control' },
  { name: 'secure-lawn', url: '/preview-secure.html?v=lawn', ready: 'Lawn Care' },
  { name: 'service-report', url: '/preview-service-report.html', ready: 'Quarterly Pest Control' },
  { name: 'lawn-story', url: '/preview-service-report.html?scenario=lawn-story', ready: 'Your lawn today', verify: verifyLawnStoryPrint },
  { name: 'completion', url: '/preview-completion-presets.html', ready: 'Completion' },
  { name: 'track', url: '/preview-track.html', ready: 'Alex arrives in', verify: verifyTracker },
  { name: 'track-scheduled', url: '/preview-track.html?state=scheduled', ready: 'stops before yours' },
  { name: 'reschedule', url: '/preview-schedule-flow.html', ready: 'Our best times for you', verify: verifyScheduleFlow },
  { name: 'reservice', url: '/preview-schedule-flow.html?flow=reservice', ready: 'pests back between visits', verify: verifyScheduleFlow },
];
const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };

async function assertNoOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 2, `Horizontal overflow: ${overflow}px`);
}

async function verifyLogin(page) {
  const phone = page.getByRole('textbox', { name: 'Phone number', exact: true });
  await phone.fill('9415550147');
  assert.equal(await phone.inputValue(), '(941) 555-0147');
  assert.equal(await page.getByRole('button', { name: 'Send code', exact: true }).isEnabled(), true);
  // Exercise input/focus without submitting an authentication request.
  assert.equal(await phone.evaluate((element) => document.activeElement === element), true);
}

async function verifyLawnStoryPrint(page, key) {
  const score = page.locator('.lawn-story-score');
  const scoreText = await score.innerText();
  assert.match(scoreText.replace(/\s/g, ''), /^72\/100$/);
  await page.getByRole('link', { name: 'View lawn details' }).focus();
  await page.keyboard.press('Enter');
  const breakdown = page.locator('#lawn-section-score details.lawn-layout-score');
  assert.equal(await breakdown.evaluate((element) => element.open), true);
  assert.equal(await breakdown.locator(':scope > summary').evaluate((element) => document.activeElement === element), true);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.equal(await score.isVisible(), true, 'The overall score must survive printing the live story report');
  assert.equal(await score.innerText(), scoreText);
  assert.equal(await page.getByRole('link', { name: 'View lawn details' }).isVisible(), false);
  await page.screenshot({ path: path.join(artifactDir, `${key}-print.png`), fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await breakdown.locator(':scope > summary').innerText(), 'Score details', 'Printing must not restore a duplicate score on screen');
}

async function verifyGlassPointer(page) {
  // Exercise a real edge click during the entrance. Cancelling the transform
  // on pointer-down moves the button before pointer-up and silently loses it.
  await page.evaluate(() => {
    const card = document.createElement('section');
    card.id = 'qa-glass-pointer';
    card.setAttribute('data-glass', 'card');
    card.style.cssText = 'position:relative;z-index:4;width:320px;max-width:calc(100% - 32px);height:250px;margin:20px auto;padding:20px;box-sizing:border-box;display:flex;flex-direction:column';
    card.innerHTML = '<p>Glass pointer check</p><button type="button" data-glass-accent style="margin-top:auto;height:44px;flex:none">Continue</button>';
    card.querySelector('button').onclick = () => card.setAttribute('data-clicked', 'true');
    document.body.prepend(card);
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => document.getElementById('qa-glass-pointer').getAnimations().some((animation) => animation.effect.getTiming().duration === 1000));
  await page.evaluate(() => {
    const animation = document.getElementById('qa-glass-pointer').getAnimations().find((item) => item.effect.getTiming().duration === 1000);
    animation.pause();
    animation.currentTime = 0;
  });
  const button = page.locator('#qa-glass-pointer button');
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
  const before = await button.boundingBox();
  await page.mouse.down();
  const held = await button.boundingBox();
  assert.ok(Math.abs(held.y - before.y) < 1 && Math.abs(held.height - before.height) < 1, 'Glass entrance moved a pressed button');
  await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('qa-glass-pointer').getAttribute('data-clicked') === 'true');
  await page.waitForFunction(() => !document.getElementById('qa-glass-pointer').hasAttribute('data-glass-motion-state'));
  await page.locator('#qa-glass-pointer').evaluate((card) => card.remove());
}

async function assertShellSafeArea(page, scenario, viewport, insets) {
  // Login owns its gutters; the report uses CustomerColumn. Both must fit
  // inside the notch boundaries provided by their shared WavesShell.
  const content = page.locator(scenario.name === 'login'
    ? '.portal-login-brand, .portal-login-card' : 'h1.sr-title');
  assert.ok(await content.count(), 'Expected customer main content');
  for (const element of await content.all()) {
    const box = await element.boundingBox();
    assert.ok(box, 'Expected visible customer main content');
    assert.ok(box.x >= insets.left, `${scenario.name}: main content starts at ${box.x}px inside the ${insets.left}px left notch`);
    assert.ok(box.x + box.width <= viewport.width - insets.right + 1,
      `${scenario.name}: main content extends into the right notch`);
  }
}

async function verifyTracker(page) {
  assert.match(await page.getByRole('link', { name: 'TEXT ALEX', exact: true }).getAttribute('href'), /^sms:/);
  await page.goto(new URL('/preview-track.html?state=complete', page.url()).href);
  await page.getByText('Thanks for choosing Waves, Jordan.').waitFor();
  assert.match(await page.getByRole('link', { name: 'View service report', exact: true }).getAttribute('href'), /^\/report\//);
  assert.equal(await page.getByRole('link', { name: 'TEXT ALEX', exact: true }).count(), 0);
}

async function verifyScheduleFlow(page, key) {
  await page.getByRole('textbox', { name: 'Search for a service date or time' }).fill('An afternoon');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('Afternoon openings from the preview calendar.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Choose 9:00 AM/ }).count(), 0);
  await page.getByRole('button', { name: 'Show all open times', exact: true }).click();
  await page.getByRole('button', { name: /^Choose 9:00 AM/ }).first().click();
  await page.screenshot({ path: path.join(artifactDir, `${key}-selected.png`), fullPage: true });
  await page.getByRole('button', { name: /^(Confirm|Book).*→/ }).click();
  await page.getByText("You're all set", { exact: true }).waitFor();
  // Fixture job ends at 10:30; the customer arrival promise stays two hours.
  await page.getByText('9:00 AM–11:00 AM', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, `${key}-confirmed.png`), fullPage: true });
}

async function checkScenario(browser, baseUrl, scenario, viewportName, viewport, safeAreaInsets) {
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
    if (safeAreaInsets) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: safeAreaInsets });
    }
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
    await assertNoOverflow(page);
    if (safeAreaInsets) await assertShellSafeArea(page, scenario, viewport, safeAreaInsets);
    await page.screenshot({ path: path.join(artifactDir, `${key}.png`), fullPage: true });
    if (scenario.verify) await scenario.verify(page, key);
    if (scenario.name === 'service-report') await verifyGlassPointer(page);
    await assertNoOverflow(page);
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
      if (scenario.name === 'login' || scenario.name === 'service-report') {
        const result = await checkScenario(browser, server.baseUrl, scenario, 'landscape-safe-area',
          { width: 844, height: 390 }, { top: 0, right: 59, bottom: 21, left: 59 });
        report.scenarios.push(result);
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${scenario.name}/${result.viewport}${result.failure ? `: ${result.failure}` : ''}`);
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
