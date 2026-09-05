#!/usr/bin/env node
'use strict';

/* global window, document, getComputedStyle -- page.evaluate callbacks run inside the headless browser, not Node */

// READ-ONLY against application state. Renders fictional dev-preview fixtures
// and writes screenshots/PDFs only to the requested artifact directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewServer: startPreviewServer, launchBrowser, evidence, previewPage, waitForFonts } = require('./qa/browser');

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
// Fixtures that offer the slot picker on load (canAccept + standard_slot_pick).
// One of these rendering no BOOKABLE slot means the fixture clock drifted and
// the audit silently stopped exercising the selectable-slot and
// post-selection states — report it instead of shipping stale screenshots.
const SLOT_PICKER_SCENARIOS = [
  'pest', 'lawn', 'mosquito', 'tree_shrub', 'termite_bait', 'rodent', 'wdo', 'termite_foam',
  'trap_only', 'bundle', 'commercial', 'bundle_referral', 'lawn_member_upgrade', 'missing_contact', 'long_content', 'preslab',
];
// Fixtures with no priced line: the server withholds documentRender, so the
// pdf pass must fall through to the normal page rather than print an
// official-looking document with no pricing table.
const PDF_FALLTHROUGH_SCENARIOS = ['quote_required'];
const root = path.resolve(__dirname, '..');
let baseUrl;
const provenance = evidence(root);
const artifactDir = process.env.ESTIMATE_PREVIEW_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'waves-estimate-audit-'));
fs.mkdirSync(artifactDir, { recursive: true });

const failures = [];
const observations = [];
const fail = (scenario, viewport, message) => failures.push({ scenario, viewport, message });

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

// Runs inside the browser. Shared by the pre-selection and post-selection
// passes so overflow/clipping/wording checks cover both states.
const auditPageInBrowser = () => {
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
    slots: {
      // The shared SchedulePicker renders the picked day's times as
      // [data-schedule-slot] buttons; stale windows are filtered out before
      // render, so an empty list is the drift signal.
      offered: document.querySelectorAll('[data-schedule-slot]').length,
      stale: 0,
      selected: document.querySelectorAll('[data-schedule-slot][aria-pressed="true"]').length,
      approveCta: /Approve — /.test(bodyText),
    },
  };
};

(async () => {
  let previewServer = null;
  let browser = null;
  try {
    previewServer = await startPreviewServer(root, process.env.ESTIMATE_PREVIEW_BASE_URL);
    baseUrl = previewServer.baseUrl;
    browser = await launchBrowser();
    for (const scenario of SCENARIOS) {
      for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
        const page = await previewPage(browser, baseUrl, viewport);
        const runtimeErrors = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        const url = `${baseUrl}/preview-estimate.html?scenario=${scenario}&chrome=0`;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15000 });
        // Full-page screenshots do not keep every below-fold IntersectionObserver
        // target intersecting at capture time. Force the already-rendered cards
        // visible for the audit artifact; production behavior is unchanged.
        await page.addStyleTag({ content: 'html[data-glass-theme] [data-glass].glass-reveal-pending{opacity:1!important;transform:none!important}' });
        await waitForFonts(page);
        await revealWholePage(page);

        if (!response?.ok()) fail(scenario, viewportName, `HTTP ${response?.status() || 'no response'}`);
        runtimeErrors.forEach((message) => fail(scenario, viewportName, `page error: ${message}`));

        const audit = await page.evaluate(auditPageInBrowser);
        const checkPage = (result, state) => {
          if (!result.h1) fail(scenario, state, 'missing customer-facing H1');
          if (result.horizontalOverflow > 2) fail(scenario, state, `document overflows horizontally by ${result.horizontalOverflow}px: ${result.overflowElements.join(' | ')}`);
          if (result.clippedText.length) fail(scenario, state, `clipped text: ${result.clippedText.join(' | ')}`);
          if (/\b(?:pet|kid|child)[^\n.?!]{0,40}\bsafe\b|\bsafe\b[^\n.?!]{0,40}\b(?:pet|kid|child)/i.test(result.bodyText)) fail(scenario, state, 'blanket pet/child safety wording is visible');
          if (/\b(?:wdo_inspection|termite_foam|trap_only_retainer)\b/.test(result.bodyText)) fail(scenario, state, 'internal service key is visible');
          if (['wdo', 'preslab'].includes(scenario) && /Waves AI reviewed|Ask Waves|prepared for the property shown/i.test(result.bodyText)) {
            fail(scenario, state, `${scenario} incorrectly renders AI narrative or an ask bar`);
          }
          if (result.slots.stale > 0) fail(scenario, state, `${result.slots.stale} of ${result.slots.offered} offered slots are stale (fixture clock drifted)`);
        };
        checkPage(audit, viewportName);
        if (SLOT_PICKER_SCENARIOS.includes(scenario) && audit.slots.offered - audit.slots.stale === 0) fail(scenario, viewportName, 'no bookable slot offered');
        await page.screenshot({ path: path.join(artifactDir, `${scenario}-${viewportName}.png`), fullPage: true });

        // Post-selection state: pick the first bookable slot and re-audit —
        // selected-card styling, the slot-aware "Approve — <day time>" CTA,
        // and any overflow the selection introduces are otherwise invisible
        // to a pre-selection screenshot.
        let selected = null;
        if (audit.slots.offered - audit.slots.stale > 0) {
          await page.locator('[data-schedule-slot]:not([disabled])').first().click();
          await page.waitForTimeout(250);
          await revealWholePage(page);
          selected = await page.evaluate(auditPageInBrowser);
          checkPage(selected, `${viewportName}-selected`);
          if (selected.slots.selected !== 1) fail(scenario, `${viewportName}-selected`, `expected exactly one selected slot card, found ${selected.slots.selected}`);
          if (!selected.slots.approveCta) fail(scenario, `${viewportName}-selected`, 'slot-aware Approve CTA did not appear after selecting a slot');
          await page.screenshot({ path: path.join(artifactDir, `${scenario}-${viewportName}-selected.png`), fullPage: true });
        }

        observations.push({ scenario, viewport: viewportName, h1: audit.h1, actions: audit.buttons.slice(0, 8), slots: audit.slots, selectedSlot: selected ? selected.slots : null });
        await page.close();
      }

      const printPage = await previewPage(browser, baseUrl, VIEWPORTS.desktop);
      const printUrl = `${baseUrl}/preview-estimate.html?scenario=${scenario}&chrome=0&mode=pdf`;
      await printPage.goto(printUrl, { waitUntil: 'domcontentloaded' });
      await printPage.locator('.estimate-document-v1, h1').first().waitFor({ state: 'visible', timeout: 15000 });
      await waitForFonts(printPage);
      // The print artifact is only evidence if it carries the pricing table
      // the customer's emailed PDF prints (proposal buildings / programs /
      // corrective work) — an official-looking document without one would
      // let a PDF pricing regression pass as a SUCCESS.
      const print = await printPage.evaluate(() => {
        const doc = document.querySelector('.estimate-document-v1');
        const text = doc ? doc.innerText : '';
        return {
          document: Boolean(doc),
          pricingHeader: /Your services & pricing|Your proposal|Investment/i.test(text),
          // Itemized service rows only (building line items, program price
          // rows, corrective work) — the independently rendered totals block
          // must not stand in for a missing pricing table.
          pricedLines: [...document.querySelectorAll('.estimate-document-v1 [data-estimate-document-line]')]
            .filter((row) => /\$\d[\d,]*\.\d{2}/.test(row.innerText)).length,
          h1: document.querySelector('h1')?.textContent?.trim() || '',
        };
      });
      if (PDF_FALLTHROUGH_SCENARIOS.includes(scenario)) {
        if (print.document) fail(scenario, 'print', 'unpriced estimate rendered the print document instead of falling through');
        else if (!print.h1) fail(scenario, 'print', 'pdf fall-through lost the customer-facing page');
      } else if (!print.document) {
        fail(scenario, 'print', 'pdf pass fell through to the normal page (documentRender withheld)');
      } else if (!print.pricingHeader || print.pricedLines === 0) {
        fail(scenario, 'print', 'print document rendered without an itemized pricing table');
      }
      observations.push({ scenario, viewport: 'print', document: print.document, pricedLines: print.pricedLines });
      await printPage.emulateMedia({ media: 'print' });
      await printPage.pdf({ path: path.join(artifactDir, `${scenario}-print.pdf`), format: 'Letter', printBackground: true, margin: { top: '0.35in', right: '0.35in', bottom: '0.35in', left: '0.35in' } });
      await printPage.close();
    }
  } finally {
    await browser?.close();
    await previewServer?.close();
  }

  const result = {
    provenance,
    artifactDir,
    scenarios: SCENARIOS.length,
    renderedPages: observations.filter((entry) => entry.viewport !== 'print').length,
    printedDocuments: observations.filter((entry) => entry.viewport === 'print' && entry.document).length,
    failures,
    observations,
  };
  fs.writeFileSync(path.join(artifactDir, 'audit.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
