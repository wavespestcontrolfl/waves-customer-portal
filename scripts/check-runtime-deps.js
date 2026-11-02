#!/usr/bin/env node
/**
 * Runtime-deps check for a new production image (owner 2026-11-02, build-line-limit fix).
 *
 * Railway runs the pre-deploy command in a container from the NEW image before it takes
 * traffic; a non-zero exit fails that deploy and production stays on the last good one.
 * Run here, this refuses an image that lacks a binary the app shells out to, on any builder:
 *   - ffmpeg: the Reel MP4 metadata strip (social-media.js) and the recap transcoder
 *     (service-report/recap-transcode.js) both spawn `process.env.FFMPEG_PATH || 'ffmpeg'`
 *     and fail closed without it.
 *   - Playwright's Chromium: report PDFs (service-report/pdf-puppeteer.js), price scans,
 *     the procurement adapter, event ingestion, the SEO form filler.
 *
 * File-exists / ENOENT checks only: no browser launch in pre-deploy (shared memory, sandbox
 * and start-up time can fail a good image), so only a truly missing binary fails the deploy.
 * Anything else is logged and passes. `--pdf` adds a real Chromium launch and one PDF; the
 * deploy-image CI job uses it on the built image, pre-deploy does not.
 *
 * Run it through a login shell (`/bin/bash -l -c "..."`), as the app runs: the Nix profile
 * that puts node and ffmpeg on PATH is loaded by the login shell.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const FFMPEG_TIMEOUT_MS = 10000;

function checkFfmpeg({ exec = execFileSync, env = process.env } = {}) {
  const bin = env.FFMPEG_PATH || 'ffmpeg';
  try {
    exec(bin, ['-version'], { stdio: 'ignore', timeout: FFMPEG_TIMEOUT_MS });
    return { name: 'ffmpeg', ok: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { name: 'ffmpeg', ok: false, reason: `${bin} not found` };
    }
    const why = (err && (err.code || err.signal)) || 'error';
    return { name: 'ffmpeg', ok: true, warning: `ffmpeg -version did not finish cleanly (${why})` };
  }
}

function loadChromium(loadPlaywright) {
  try {
    return { chromium: loadPlaywright().chromium };
  } catch (err) {
    return { reason: `playwright not installed (${(err && err.code) || 'error'})` };
  }
}

function checkChromium({ loadPlaywright = () => require('playwright'), exists = fs.existsSync } = {}) {
  const { chromium, reason } = loadChromium(loadPlaywright);
  if (!chromium) return { name: 'chromium', ok: false, reason };
  const path = chromium.executablePath();
  if (!path || !exists(path)) {
    return { name: 'chromium', ok: false, reason: `executable missing at ${path || '(no path)'}` };
  }
  return { name: 'chromium', ok: true };
}

// CI only (--pdf): prove Chromium starts and prints, i.e. its libraries and fonts are in the image.
async function printPdf({ loadPlaywright = () => require('playwright') } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Waves Pest Control</h1><p>Runtime check: Chromium prints.</p>');
    const pdf = await page.pdf({ format: 'Letter' });
    return { name: 'chromium-pdf', ok: pdf.length > 1000, reason: `pdf ${pdf.length} bytes` };
  } finally {
    await browser.close();
  }
}

function report(results, { log, error }) {
  for (const r of results) {
    if (!r.ok) error(`[runtime-deps] MISSING ${r.name}: ${r.reason}`);
    else if (r.warning) log(`[runtime-deps] ${r.name}: present (${r.warning})`);
    else log(`[runtime-deps] ${r.name}: present${r.reason ? ` (${r.reason})` : ''}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

async function run({ argv = process.argv.slice(2), log = console.log, error = console.error, ...deps } = {}) {
  const results = [checkFfmpeg(deps), checkChromium(deps)];
  if (argv.includes('--pdf') && results.every((r) => r.ok)) {
    try {
      results.push(await printPdf(deps));
    } catch (err) {
      results.push({ name: 'chromium-pdf', ok: false, reason: (err && err.message) || 'launch failed' });
    }
  }
  return report(results, { log, error });
}

if (require.main === module) {
  run().then((code) => { process.exitCode = code; });
}

module.exports = { checkFfmpeg, checkChromium, printPdf, run };
