'use strict';
/* global document */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = {
  name: 'customer-otp-login-and-permissions',
  async run(ctx) {
    const { page, fixture, baseUrl, json, artifactDir, captureFile, waitForFonts } = ctx;
    await page.goto(`${baseUrl}/login`);
    await page.getByLabel('Phone number', { exact: true }).fill(fixture.phone.slice(2));
    const send = page.waitForResponse((response) => response.url().endsWith('/api/auth/send-code'));
    await page.getByRole('button', { name: 'Send code', exact: true }).click();
    await json(await send);
    const captures = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const code = captures.filter((item) => item.kind === 'verification').at(-1)?.code;
    assert.ok(code, 'Expected captured OTP from the real send-code route');
    await page.getByLabel('Verification code', { exact: true }).fill(code);
    const login = page.waitForResponse((response) => response.url().endsWith('/api/auth/verify-code'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const session = await json(await login);
    ctx.customerToken = session.token;
    ctx.customerRefreshToken = session.refreshToken;
    assert.ok(ctx.customerToken);
    assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`, { headers: { Authorization: `Bearer ${ctx.customerToken}` } })).status(), 401);
    await page.waitForFunction(() => document.body.innerText.includes('QA'));
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'customer-portal.png'), fullPage: true });
  },
};
