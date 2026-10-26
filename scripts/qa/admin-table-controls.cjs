"use strict";
/* global document, localStorage, navigator, getComputedStyle */
// Synthetic frontend-only proof. All API requests are intercepted; unknown
// routes, external requests, sockets, and provider actions cannot reach a server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-table-controls");
const onlyCustomers = process.argv.includes("--customers");
const onlyBids = process.argv.includes("--bids");
const customers = Array.from({ length: 55 }, (_, index) => ({
  id: `customer-${index + 1}`, firstName: "Customer", lastName: `Example ${String(index + 1).padStart(3, "0")}`,
  address: `${index + 1} Demonstration Street, Example City, FL`, tier: "Silver", healthScore: 82,
  pipelineStage: "active_customer", active: true, nextServiceDate: "2099-04-20", overdueInvoiceCount: 0,
}));
const bids = Array.from({ length: 52 }, (_, index) => ({
  id: `bid-${index + 1}`, project_title: `Example project ${String(index + 1).padStart(3, "0")}`,
  gc_or_agency: `Example agency ${52 - index}`, source: index % 2 ? "bluebook" : "sam_gov",
  status: index < 36 ? "new" : "submitted", historical: index === 30,
  due_at: index === 0 ? null : `2099-04-${String(index % 25 + 1).padStart(2, "0")}T21:00:00Z`,
  due_confirmed: true, days_left: index, email_count: 0,
}));

function fixtures(url, method, report) {
  if (method === "POST" && url.pathname === "/api/admin/usage/track") return {};
  if (method !== "GET") return undefined;
  if (url.pathname === "/api/admin/customers") {
    report.customerQueries.push(Object.fromEntries(url.searchParams));
    const query = (url.searchParams.get("search") || "").toLowerCase();
    const rows = customers.filter((row) => `${row.firstName} ${row.lastName}`.toLowerCase().includes(query));
    if (url.searchParams.get("order") === "desc") rows.reverse();
    const limit = Number(url.searchParams.get("limit") || 500), page = Number(url.searchParams.get("page") || 1);
    return { customers: rows.slice((page - 1) * limit, page * limit), total: rows.length, totalPages: Math.ceil(rows.length / limit), page, limit };
  }
  switch (url.pathname) {
    case "/api/admin/auth/me": return { id: "fixture-admin", role: "admin", name: "Fixture operator" };
    case "/api/admin/feature-flags": return { flags: { bid_desk: true } };
    case "/api/admin/notifications/unread-count": return { count: 0 };
    case "/api/admin/communications/unread-count": return { count: 0, conversations: 0 };
    case "/api/admin/requests": return { requests: [] };
    case "/api/admin/call-recordings/commitments/open":
    case "/api/admin/call-recordings/commitments/sms": return { commitments: [], enabled: true, has_more: false };
    case "/api/admin/customer-geocodes": return { enabled: false };
    case "/api/admin/bid-desk/": return { bids };
    default: return undefined;
  }
}

async function geometry(page, label) {
  const results = await page.getByRole("region", { name: `${label} controls`, exact: true }).evaluate((region) => {
    const rect = region.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controls: [...region.querySelectorAll("input, select, button")].map((control) => {
        const box = control.getBoundingClientRect(), style = getComputedStyle(control);
        return { name: control.getAttribute("aria-label") || control.textContent.trim(),
          height: box.height, font: parseFloat(style.fontSize), appearance: style.appearance,
          border: style.borderTopStyle, borderWidth: parseFloat(style.borderTopWidth), outside: box.left < rect.left - 1 || box.right > rect.right + 1,
          field: control.tagName === "INPUT" || control.tagName === "SELECT" };
      }),
    };
  });
  assert.ok(results.pageOverflow <= 1, `Page overflow: ${label}`);
  for (const control of results.controls) {
    assert.ok(control.height >= 43.5, `Short control: ${JSON.stringify(control)}`);
    assert.ok(control.font >= (control.field ? 16 : 14), `Small control text: ${JSON.stringify(control)}`);
    assert.ok(!control.outside, `Control leaves toolbar: ${JSON.stringify(control)}`);
    assert.ok(!control.borderWidth || !["inset", "outset"].includes(control.border), `Native beveled border: ${control.name}`);
  }
  return results;
}

async function screenshot(page, report, name) {
  const filename = `${report.engine}-${report.width}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename) });
  report.screenshots.push(filename);
}

async function columns(page, report, label, optional, selector) {
  const toolbar = page.getByRole("region", { name: `${label} controls`, exact: true });
  const trigger = toolbar.getByRole("button", { name: "Columns", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: `${label} columns`, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox").first().isDisabled(), true, "Identity cannot be hidden");
  await dialog.getByRole("checkbox", { name: optional, exact: true }).uncheck();
  await screenshot(page, report, `${label.toLowerCase().replaceAll(" ", "-")}-columns`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate((node) => document.activeElement === node), true, "Column picker restores focus");
  assert.equal(await page.locator(selector).count(), 0, `${optional} column is hidden`);
  await trigger.click();
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.ok(await page.locator(selector).count() > 0, "Show all restores the column");
}

async function exerciseCustomers(page, server, report) {
  await page.goto(`${server.baseUrl}/admin/customers?tableControls=1`);
  const customerSearch = page.getByRole("searchbox", { name: "Customers search" });
  await customerSearch.waitFor();
  await page.getByRole("button", { name: "Open Customer Example 001 customer profile", exact: true }).waitFor();
  await waitForFonts(page);
  report.geometry.push(await geometry(page, "Customers"));
  await screenshot(page, report, "customers-toolbar");
  await columns(page, report, "Customers", "Property", '.customer-directory-table th[data-column="property"]');
  const customerPager = page.getByRole("navigation", { name: "Customers pagination", exact: true });
  await customerPager.getByRole("combobox").selectOption("25");
  await customerPager.getByText("Page 1 of 3", { exact: true }).waitFor();
  await customerPager.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Open Customer Example 026 customer profile", exact: true }).waitFor();
  await customerPager.getByText("Page 2 of 3", { exact: true }).waitFor();
  await screenshot(page, report, "customers-pagination");
  await customerSearch.fill("Example 040");
  await page.getByRole("button", { name: "Open Customer Example 040 customer profile", exact: true }).waitFor();
  await customerPager.getByText("Page 1 of 1", { exact: true }).waitFor();
  assert.equal(await customerPager.getByRole("button", { name: "Next page" }).isDisabled(), true);
  assert.ok(report.customerQueries.some((query) => query.page === "2" && query.limit === "25"));
  assert.ok(report.customerQueries.some((query) => query.page === "1" && query.search === "Example 040"));
  await customerSearch.fill("Nothing matches this fixture");
  await customerPager.getByText("0–0 of 0 exact matches", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page.getByRole("button", { name: "Open Customer Example 001 customer profile", exact: true }).waitFor();
  const customerSort = page.getByRole("region", { name: "Customers controls", exact: true }).getByRole("combobox", { name: "Customers sort", exact: true });
  await customerSort.selectOption({ label: "Name Z–A" });
  await page.getByRole("button", { name: "Open Customer Example 055 customer profile", exact: true }).waitFor();
  assert.equal(report.customerQueries.at(-1).order, "desc");
}

async function exerciseBids(page, server, report) {
  await page.goto(`${server.baseUrl}/admin/bids?tableControls=1`);
  const bidSearch = page.getByRole("searchbox", { name: "Bid Desk search" });
  await bidSearch.waitFor();
  await page.getByRole("button", { name: "Open Example project 001", exact: true }).waitFor();
  await waitForFonts(page);
  report.geometry.push(await geometry(page, "Bid Desk"));
  await page.getByRole("region", { name: "Bid Desk controls", exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, report, "bids-toolbar");
  await columns(page, report, "Bid Desk", "Buyer", '.bid-desk-table td[data-label="Buyer"]');
  const bidPager = page.getByRole("navigation", { name: "Bid Desk pagination", exact: true });
  await bidPager.getByRole("combobox").selectOption("25");
  await bidPager.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Open Example project 026", exact: true }).waitFor();
  await bidSearch.fill("project 002");
  await bidPager.getByText("1–1 of 1 loaded bids", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page.getByRole("region", { name: "Bid Desk controls", exact: true }).getByLabel("Status", { exact: true }).selectOption("all");
  await bidSearch.fill("project 040");
  await page.getByRole("button", { name: "Open Example project 040", exact: true }).waitFor();
  await bidPager.getByText("Page 1 of 1", { exact: true }).waitFor();
  await screenshot(page, report, "bids-filtered");
  for (const width of [320, 820, 1101]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    report.geometry.push(await geometry(page, "Bid Desk"));
    if (width === 1101) {
      const sizes = await page.getByRole("table", { name: "Bid desk projects", exact: true }).evaluate((table) => ({
        table: table.getBoundingClientRect().width, project: table.tBodies[0].rows[0].cells[0].getBoundingClientRect().width,
      }));
      assert.ok(sizes.table >= 1099 && sizes.project >= 279, "Desktop columns retain their readable widths");
    }
  }
  await page.goto(`${server.baseUrl}/admin/bids`);
  await page.getByRole("group", { name: "Filter", exact: true }).waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Bid Desk search" }).count(), 0, "Preview remains opt-in");
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, scenarios: [] };
  let server;
  try {
    server = await previewServer(root);
    for (const engine of ["chromium", "webkit"]) {
      const browser = engine === "chromium" ? await launchBrowser() : await webkit.launch({ headless: true });
      try {
        for (const width of [390, 1440]) {
          const scenario = { engine, width, errors: [], unmatched: [], customerQueries: [], geometry: [], screenshots: [] };
          report.scenarios.push(scenario);
          const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, timezoneId: "America/New_York", serviceWorkers: "block" });
          await context.routeWebSocket("**/socket.io/**", (socket) => socket.close());
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          page.setDefaultNavigationTimeout(60000);
          await page.addInitScript(() => {
            localStorage.setItem("waves_admin_token", "synthetic-local-token");
            localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-admin", role: "admin", name: "Fixture operator" }));
            if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: "synthetic" });
          });
          page.on("pageerror", (error) => scenario.errors.push(error.message));
          await page.route("**/*", (route) => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io")) return route.abort();
            if (!url.pathname.startsWith("/api/")) return route.continue();
            const body = fixtures(url, request.method(), scenario);
            if (body === undefined) scenario.unmatched.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({ status: body === undefined ? 404 : 200, contentType: "application/json", body: JSON.stringify(body ?? { error: "Unexpected synthetic request" }) });
          });
          if (!onlyBids) await exerciseCustomers(page, server, scenario);
          if (!onlyCustomers) await exerciseBids(page, server, scenario);
          assert.deepEqual(scenario.errors, []);
          assert.deepEqual(scenario.unmatched, []);
          await context.close();
        }
      } finally { await browser.close(); }
    }
    report.passed = true;
    console.log(`Passed ${report.scenarios.length} Chromium/WebKit table-control scenarios.`);
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (server) await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
