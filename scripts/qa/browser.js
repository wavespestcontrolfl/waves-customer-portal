'use strict';
/* global document */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { setup, childEnvironment, git, checkoutStamp } = require('../dev/context');

async function previewServer(root, requestedUrl) {
  const context = await setup(root);
  const url = new URL(requestedUrl || `http://127.0.0.1:${context.ports.client}`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('Preview audits require a local HTTP server.');
  }
  const baseUrl = url.origin;
  const stamp = checkoutStamp(root);
  async function probe() {
    let response;
    try { response = await fetch(`${baseUrl}/preview-estimate.html`, { signal: AbortSignal.timeout(1000) }); }
    catch { return false; }
    if (response.headers.get('x-waves-checkout') !== stamp) throw new Error('Preview server belongs to another checkout or commit. Stop it and restart from this worktree.');
    return response.ok;
  }
  if (await probe()) return { baseUrl, close: async () => {} };
  if (requestedUrl) throw new Error('Requested preview server is unavailable.');
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
    '--port', String(context.ports.client), '--strictPort'], {
    cwd: path.join(root, 'client'), env: childEnvironment(context), stdio: 'inherit',
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (spawnError || child.exitCode !== null) throw new Error('Preview server failed to start.');
      if (await probe()) return { baseUrl, close };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Preview server startup timed out.');
  } catch (error) { await close(); throw error; }
}

async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    const executablePath = process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (!fs.existsSync(executablePath)) throw error;
    return chromium.launch({ headless: true, executablePath });
  }
}

function evidence(root) {
  return { sha: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'),
    checkout: checkoutStamp(root), dirty: Boolean(git(root, 'status', '--porcelain')),
    startedAt: new Date().toISOString(), timezone: 'America/New_York' };
}

async function previewPage(browser, baseUrl, viewport) {
  const page = await browser.newPage({ viewport, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseUrl).origin || url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  return page;
}

async function waitForFonts(page) {
  const families = ['Inter', 'Roboto', ...Object.keys(require('../../client/public/fonts/sources.json').licenses)];
  await page.evaluate(async (required) => {
    await document.fonts.ready;
    for (const family of required) {
      const faces = await document.fonts.load(`16px "${family}"`);
      if (!faces.length || faces.some((face) => face.status !== 'loaded')) {
        throw new Error(`QA font unavailable: ${family}`);
      }
    }
  }, families);
}

module.exports = { waitForFonts, previewPage, previewServer, launchBrowser, evidence };
