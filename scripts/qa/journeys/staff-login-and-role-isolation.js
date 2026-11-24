'use strict';
const assert = require('node:assert/strict');

module.exports = {
  name: 'staff-login-and-role-isolation',
  async run(ctx) {
    const { page, fixture, baseUrl, json } = ctx;
    await page.goto(`${baseUrl}/admin/login`);
    await page.getByLabel('Email address', { exact: true }).fill(fixture.adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    const login = page.waitForResponse((response) => response.url().endsWith('/api/admin/auth/login'));
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    ctx.adminToken = (await json(await login)).token;
    assert.ok(ctx.adminToken);
    const tech = await json(await page.request.post(`${baseUrl}/api/admin/auth/login`, { data: { email: fixture.techEmail, password: fixture.password } }));
    ctx.techToken = tech.token;
    ctx.otherTechToken = (await json(await page.request.post(`${baseUrl}/api/admin/auth/login`, { data: { email: fixture.otherTechEmail, password: fixture.password } }))).token;
    assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`, { headers: { Authorization: `Bearer ${tech.token}` } })).status(), 403);
    assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`)).status(), 401);
  },
};
