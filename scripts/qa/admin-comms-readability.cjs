"use strict";
/* global document, localStorage, navigator, innerWidth, getComputedStyle */
// Synthetic frontend QA: every API is fulfilled here and every external request is blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-comms-readability");
const previewUrl = process.env.ADMIN_UI_PREVIEW_URL;
const smsBody = "Please confirm the side gate is unlocked before service.";
const html = `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/index.css"></head><body><main id="root" class="admin-shell-v2"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const {UiSurface}=await import('/src/components/ui/UiSurface.jsx');
const Panel=(await import('/src/pages/admin/EmailTemplatesPanelV2.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(UiSurface,{density:'comfortable',className:'p-4'},React.createElement(Panel)));
</script></body></html>`;

const template = { template_key: "fixture-template", name: "Fixture service notice", mode: "service", purpose: "qa", status: "active", active_version_id: "version-1", allowed_variables: [] };
const automation = { automation_key: "fixture-automation", name: "Fixture follow-up", template_key: template.template_key, trigger_event_key: "service.completed", delay_minutes: 15, audience: "customer", status: "active", suppression_group_key: "service", legal_classification: "transactional_relationship", conditions: {}, exit_conditions: {}, owner: "operations", timezone: "America/New_York", can_delete: false };

function fixture(url) {
  const p = url.pathname;
  if (p === "/api/admin/auth/me") return { id: "fixture-owner", name: "Fixture operator", role: "admin" };
  if (p === "/api/health") return { status: "ok", gates: {} };
  if (p === "/api/admin/feature-flags") return { flags: {} };
  if (p === "/api/admin/notifications/unread-count") return { count: 0 };
  if (p === "/api/admin/usage/track") return {};
  if (p === "/api/admin/communications/unread-count") return { conversations: 0, messages: 0 };
  if (p === "/api/admin/communications/log") return { messages: [{ id: "sms-readable", from: "+19415550100", to: "+19413187612", direction: "inbound", body: smsBody, customerName: "Avery Sample", customerId: "customer-a", status: "received", messageType: "manual", createdAt: "2026-10-25T14:00:00Z", isRead: true }], page: 1, hasMore: false };
  if (p === "/api/admin/communications/stats") return { totalSent: 1, totalReceived: 1, channelStats: [] };
  if (p === "/api/admin/communications/blocked-numbers") return { blocked: [], numbers: [] };
  if (p === "/api/admin/communications/ai-auto-reply-status") return { enabled: false };
  if (p === "/api/admin/communications/agent-draft") return { draft: null };
  if (p === "/api/admin/communications/link-library") return { links: [] };
  if (p === "/api/admin/communications/sender") return { fromNumber: null };
  if (p === "/api/tech/dictation/availability") return { available: false };
  if (p === "/api/admin/triage/held-lines") return { lines: [] };
  if (p === "/api/admin/triage/auto-routed") return { items: [], counts: { open: 1, in_progress: 2, resolved: 3, dismissed: 4 } };
  if (p === "/api/admin/triage") return { items: [], counts: { open: 1, in_progress: 2, resolved: 3, dismissed: 4 } };
  if (p === "/api/admin/email-templates") return { templates: [template] };
  if (p === "/api/admin/email-templates/preference-groups") return { groups: [{ key: "service", name: "Service" }] };
  if (p === "/api/admin/email-templates/fixture-template") return { template, versions: [{ id: "version-1", version_number: 1, status: "active", subject: "Fixture subject", preview_text: "", blocks: [], text_body: "Fixture body" }], fixtures: [] };
  if (p === "/api/admin/email-templates/send-history") return { messages: [{ id: "send-1", sent_at: "2026-10-25T14:00:00Z", recipient_email_snapshot: "readable-recipient@example.invalid", template_key: template.template_key, subject_snapshot: "Readable fixture subject remains intact", status: "sent", provider_message_id: "provider-fixture-1" }] };
  if (p === "/api/admin/email-templates/issues") return { issues: [{ id: "issue-1", created_at: "2026-10-25T14:05:00Z", template_key: template.template_key, event_type: "render_failed", workflow: "fixture workflow", entity_type: "customer", entity_id: "customer-a", reason: "Readable fixture issue details remain intact" }] };
  if (p === "/api/admin/email-templates/suppressions") return { suppressions: [{ id: "suppression-1", email: "suppressed-reader@example.invalid", group_key: "service", group_name: "Service", suppression_type: "manual", status: "active", blocked_count: 2, source: "fixture", suppressed_at: "2026-10-25T14:10:00Z", customer: { id: "customer-a", first_name: "Avery", last_name: "Sample", phone: "+19415550100" } }], stats: [] };
  if (p === "/api/admin/email-templates/automations") return { automations: [automation] };
  if (p === "/api/admin/email-templates/automations/fixture-automation/runs") return { runs: [{ id: "run-1", created_at: "2026-10-25T14:15:00Z", run_after: "2026-10-25T14:30:00Z", recipient_email: "automation-reader@example.invalid", entity_type: "customer", entity_id: "customer-a", status: "sent", attempts: 1, max_attempts: 3, result: "Readable automation result remains intact" }] };
}

async function main() {
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, scenarios: [], requests: [], unmatched: [], errors: [], screenshots: [], clipping: [] };
  const server = await previewServer(root, previewUrl);
  const chromium = await launchBrowser();
  const webkitBrowser = await webkit.launch({ headless: true });
  const specs = [
    { engine: "chromium", browser: chromium, width: 1440, height: 1000 },
    { engine: "chromium", browser: chromium, width: 820, height: 1000 },
    { engine: "chromium", browser: chromium, width: 390, height: 844 },
    { engine: "webkit", browser: webkitBrowser, width: 390, height: 844 },
  ];
  try {
    for (const spec of specs) {
      const tag = `${spec.engine}-${spec.width}`;
      const context = await spec.browser.newContext({ viewport: { width: spec.width, height: spec.height }, hasTouch: spec.width === 390, timezoneId: "America/New_York", serviceWorkers: "block" });
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => report.errors.push({ tag, message: error.message }));
      await page.routeWebSocket("**/*", (socket) => socket.close());
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-token");
        localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-owner", role: "admin" }));
        navigator.sendBeacon = () => true;
        if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: "synthetic" });
      });
      await page.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io")) return route.abort();
        if (url.pathname === "/qa-admin-comms-readability") return route.fulfill({ contentType: "text/html", body: html });
        if (!url.pathname.startsWith("/api/")) return route.continue();
        report.requests.push({ tag, method: request.method(), path: url.pathname, search: url.search });
        const body = fixture(url);
        if (body === undefined) { report.unmatched.push({ tag, method: request.method(), path: url.pathname, search: url.search }); return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unmatched synthetic request" }) }); }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
      const shot = async (name) => {
        if (spec.engine !== "chromium" || ![390, 1440].includes(spec.width)) return;
        const file = `${tag}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
      };
      const fontAtLeast14 = async (locator, name) => {
        const metrics = await locator.evaluate((node) => ({ font: parseFloat(getComputedStyle(node).fontSize), clipped: node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).whiteSpace !== "normal" }));
        assert.ok(metrics.font >= 14, `${tag} ${name} font ${metrics.font}px`); if (metrics.clipped) report.clipping.push(`${tag}: ${name}`);
      };

      await page.goto(`${server.baseUrl}/admin/communications#tab=sms`);
      const preview = page.getByText(smsBody, { exact: true }); await preview.waitFor(); await waitForFonts(page);
      await page.locator("button").filter({ hasText: "Log View" }).first().evaluate((button) => button.click());
      const logBody = page.locator("div.text-ui-body.break-words").filter({ hasText: smsBody }); await logBody.waitFor(); await fontAtLeast14(logBody, "SMS log body"); await logBody.scrollIntoViewIfNeeded(); await shot("sms-log");
      await page.locator("button").filter({ hasText: "Conversations" }).first().evaluate((button) => button.click());
      await preview.click(); const bubble = page.locator("#sms-message-sms-readable").getByText(smsBody, { exact: true }); await fontAtLeast14(bubble, "SMS conversation body"); await bubble.scrollIntoViewIfNeeded(); await shot("sms-conversation");

      await page.goto(`${server.baseUrl}/admin/communications#tab=triage`); await page.getByRole("button", { name: "Needs review", exact: true }).waitFor();
      for (const name of ["Needs review", "Auto-routed", /^Open \d/, /^Active \d/, /^Resolved \d/, /^Dismissed \d/]) {
        const metrics = await page.getByRole("button", { name }).evaluate((node) => ({ height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(node).fontSize) }));
        assert.ok(metrics.height >= 44 && metrics.font >= 14, `${tag} triage control ${String(name)}: ${JSON.stringify(metrics)}`);
      }
      const resolvedResponse = page.waitForResponse((response) => { const u = new URL(response.url()); return u.pathname === "/api/admin/triage" && u.searchParams.get("status") === "resolved"; });
      await page.getByRole("button", { name: /^Resolved \d/ }).click(); await resolvedResponse; await shot("triage-status-filters");
      const autoResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/triage/auto-routed");
      await page.getByRole("button", { name: "Auto-routed", exact: true }).click(); await autoResponse; await shot("triage-mode-filter");

      await page.goto(`${server.baseUrl}/qa-admin-comms-readability`); await page.getByRole("button", { name: "Send History", exact: true }).waitFor();
      const tables = [
        ["Send History", "Email send history", "readable-recipient@example.invalid"],
        ["Issues", "Email issues", "Readable fixture issue details remain intact"],
        ["Suppressions", "Email suppressions", "suppressed-reader@example.invalid"],
        ["Automations", "Email automation runs", "automation-reader@example.invalid"],
      ];
      for (const [view, label, sentinel] of tables) {
        await page.getByRole("button", { name: view, exact: true }).click();
        if (view === "Automations") { await page.getByRole("button", { name: "Runs", exact: true }).click(); }
        const table = page.getByRole("table", { name: label, exact: true }); await table.waitFor(); await page.getByText(sentinel, { exact: true }).waitFor(); await page.waitForTimeout(80);
        const cells = await table.locator("tbody td").evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
        assert.ok(cells.length > 0 && cells.every((font) => font >= 14), `${tag} ${label} cell fonts ${JSON.stringify(cells)}`);
        const scroller = table.locator("xpath=..");
        const scroll = await scroller.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth, role: node.getAttribute("role"), label: node.getAttribute("aria-label"), tabIndex: node.tabIndex }));
        if (spec.width < 1000) {
          assert.ok(scroll.scroll > scroll.client + 1, `${tag} ${label} must retain horizontal width`);
          assert.equal(scroll.role, "region", `${tag} ${label} scroll region`);
          assert.equal(scroll.label, label, `${tag} ${label} region name`);
          assert.equal(scroll.tabIndex, 0, `${tag} ${label} keyboard access`);
          await scroller.focus();
          const before = await scroller.evaluate((node) => node.scrollLeft);
          await page.keyboard.press("ArrowRight");
          assert.ok(await scroller.evaluate((node) => node.scrollLeft) > before, `${tag} ${label} ArrowRight scroll`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${tag} ${label} page overflow`);
        await shot(label.toLowerCase().replaceAll(" ", "-"));
      }
      report.scenarios.push({ tag, sms: true, triage: true, tables: tables.map(([, label]) => label) });
      await context.close();
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unmatched, []); assert.deepEqual(report.clipping, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await chromium.close(); await webkitBrowser.close(); await server.close();
  }
  console.log("Admin communications readability checks passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
