"use strict";
/* global document, localStorage, navigator, indexedDB, getComputedStyle */
// Synthetic frontend-only proof. All API requests are intercepted; unknown
// routes, external requests, sockets, and provider actions cannot reach a server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");
const root = path.resolve(__dirname, "../..");
const savedViewsScenario = process.argv.includes("--saved-views");
const output = path.join(root, savedViewsScenario ? ".tmp/admin-table-views" : ".tmp/admin-table-controls");
// Default to this PR's Bid Desk checks; opt into the companion Customers
// scenario with --customers or both pages with --all once that UI is present.
const checkCustomers = process.argv.includes("--customers") || process.argv.includes("--all");
const checkBids = !checkCustomers || process.argv.includes("--bids") || process.argv.includes("--all");
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
  const customerMatch = url.pathname.match(/^\/api\/admin\/customers\/(customer-\d+)(?:\/([^/]+))?$/);
  if (customerMatch) {
    const customer = customers.find((row) => row.id === customerMatch[1]);
    if (!customer) return undefined;
    const related = {
      "collection-holds": { holds: [] }, "contact-notification-prefs": { live: false, contacts: [] },
      activity: { enabled: false }, comms: { comms: [], composerComms: [] },
      timeline: { timeline: [], missingSources: [] }, properties: { properties: [] },
      "autopay-state": { recent_events: [] }, credits: { credits: [], balance: 0 },
    };
    if (customerMatch[2]) return related[customerMatch[2]];
    return { customer: { ...customer, address: { line1: "100 Example Lane", city: "Example City", state: "FL", zip: "34201" } },
      notificationPrefs: {}, preferences: {}, healthScore: { overall_score: 82 },
      billingSummary: { complete: true, openBalance: 0, overdueBalance: 0, overdueCount: 0 },
      invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [], customerDiscounts: [], complianceRecords: [],
      nutrientLedger: {}, services: [], payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [] };
  }
  if (/^\/api\/admin\/customer-geocodes\/customer-\d+$/.test(url.pathname)) return { enabled: false };
  const bidMatch = url.pathname.match(/^\/api\/admin\/bid-desk\/(bid-\d+)$/);
  if (bidMatch) return { bid: bids.find((bid) => bid.id === bidMatch[1]), emails: [], extras: null };
  switch (url.pathname) {
    case "/api/admin/auth/me": return { id: report.userId || "fixture-admin", role: "admin", name: "Fixture operator" };
    case "/api/admin/feature-flags": return { flags: { bid_desk: true } };
    case "/api/admin/notifications/unread-count": return { count: 0 };
    case "/api/admin/communications/unread-count": return { count: 0, conversations: 0 };
    case "/api/admin/requests": return { requests: [] };
    case "/api/admin/call-recordings/commitments/open":
    case "/api/admin/call-recordings/commitments/sms": return { commitments: [], enabled: true, has_more: false };
    case "/api/admin/customer-geocodes": return { enabled: false };
    case "/api/admin/bid-desk/": return { bids };
    case "/api/admin/payers": return { payers: [] };
    case "/api/admin/communications/numbers": return { numbers: [] };
    case "/api/admin/document-templates": return { templates: [] };
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

async function captureFailure(page, report, error) {
  report.failure = {
    message: error?.message || String(error),
    url: page.url(),
    ...(await page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 4000),
      adminMain: document.getElementById("admin-main")?.innerText.slice(0, 2000) || "",
    })).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }))),
  };
  await screenshot(page, report, "failure").catch((screenshotError) => {
    report.failure.screenshotError = screenshotError.message;
  });
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
  await page.goto(`${server.baseUrl}/admin/customers`);
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
  await page.goto(`${server.baseUrl}/admin/customers?tableControls=0`);
  await page.getByRole("searchbox", { name: "Search customers", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open Customer Example 001 customer profile", exact: true }).waitFor();
  assert.equal(await customerSearch.count(), 0, "Customer fallback hides shared controls");
  assert.equal(report.customerQueries.at(-1).limit, "500", "Customer fallback retains its request size");
}

async function exerciseBids(page, server, report) {
  await page.goto(`${server.baseUrl}/admin/bids`);
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
  await page.goto(`${server.baseUrl}/admin/bids?tableControls=0`);
  await page.getByRole("group", { name: "Filter", exact: true }).waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Bid Desk search" }).count(), 0, "Bid fallback hides shared controls");
}

const savedViewSpecs = {
  customers: { label: "Customers", path: "/admin/customers", optional: "Property", column: '.customer-directory-table th[data-column="property"]', row: "Open Customer Example 026 customer profile", record: "Open Customer Example 032 customer profile", total: "3", away: "Bids" },
  bids: { label: "Bid Desk", path: "/admin/bids", optional: "Buyer", column: '.bid-desk-table td[data-label="Buyer"]', row: "Open Example project 026", record: "Open Example project 032", total: "2", away: "Customers" },
};

async function assertScroll(page, top, storageKey, stage) {
  try {
    await page.waitForFunction((expected) => Math.abs(document.getElementById("admin-main").scrollTop - expected) < 2, top);
  } catch (error) {
    const state = await page.locator("#admin-main").evaluate((node, key) => ({
      actual: node.scrollTop,
      maximum: node.scrollHeight - node.clientHeight,
      stored: JSON.parse(localStorage.getItem(key) || "null")?.current?.scrollTop,
    }), storageKey);
    throw new Error(`Scroll restore failed at ${stage}: expected ${top}, actual ${state.actual}, stored ${state.stored}, maximum ${state.maximum}`, { cause: error });
  }
}

async function recordScroll(page, report, storageKey, stage) {
  const state = await page.locator("#admin-main").evaluate((node, input) => ({
    stage: input.stage,
    actual: node.scrollTop,
    maximum: node.scrollHeight - node.clientHeight,
    stored: JSON.parse(localStorage.getItem(input.key) || "null")?.current?.scrollTop,
  }), { key: storageKey, stage });
  report.scrollTrace = [...(report.scrollTrace || []), state];
}

async function openViews(page, label) {
  await page.getByRole("button", { name: `${label} saved views`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${label} saved views`, exact: true });
  await dialog.waitFor();
  return dialog;
}

async function exerciseSavedViews(page, context, server, report, kind) {
  const spec = savedViewSpecs[kind], url = `${server.baseUrl}${spec.path}?savedViews=1`;
  const storageKey = `waves_admin_table_views:v1:fixture-admin:admin:${kind}`;
  const readinessStartedAt = Date.now();
  await page.goto(url, { waitUntil: "commit" });
  const search = page.getByRole("searchbox", { name: `${spec.label} search`, exact: true });
  const toolbar = page.getByRole("region", { name: `${spec.label} controls`, exact: true });
  const pager = page.getByRole("navigation", { name: `${spec.label} pagination`, exact: true });
  // A fresh Vite process must transform the full admin module graph before
  // React can issue its first fixture request. Keep later interaction waits
  // strict, but give that one observable startup boundary its own budget.
  await search.waitFor({ timeout: 120000 });
  report.readiness = { ...report.readiness, [kind]: Date.now() - readinessStartedAt };
  await search.fill("Example");
  await pager.getByRole("combobox").selectOption("25");
  await pager.getByText(`Page 1 of ${spec.total}`, { exact: true }).waitFor();
  await toolbar.getByRole("button", { name: "Columns", exact: true }).click();
  const columnDialog = page.getByRole("dialog", { name: `${spec.label} columns`, exact: true });
  await columnDialog.getByRole("checkbox", { name: spec.optional, exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await columnDialog.waitFor({ state: "hidden" });
  await pager.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: spec.row, exact: true }).waitFor();
  await pager.getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await waitForFonts(page);
  const requestsBeforeScroll = report.customerQueries.length;
  const top = await page.locator("#admin-main").evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    node.scrollTo({ top: Math.min(400, node.scrollHeight - node.clientHeight), behavior: "instant" });
    return node.scrollTop;
  });
  assert.ok(top > 100, "Fixture supplies a meaningful scroll position");
  await page.waitForFunction(({ key, top }) => Math.abs(JSON.parse(localStorage.getItem(key)).current.scrollTop - top) < 2, { key: storageKey, top });
  assert.equal(report.customerQueries.length, requestsBeforeScroll, "Scrolling does not refetch Customers");
  await page.reload();
  await pager.getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: spec.row, exact: true }).waitFor();
  assert.equal(await search.inputValue(), "Example");
  assert.equal(await pager.getByRole("combobox").inputValue(), "25");
  assert.equal(await page.locator(spec.column).count(), 0);
  await assertScroll(page, top, storageKey, `${kind} reload`);
  await screenshot(page, report, `${kind}-restored`);

  // Open an actual record and return. The record's own scrolling must not
  // replace the position saved for this list.
  const row = page.getByRole("button", { name: spec.record, exact: true });
  await row.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
  const beforeRecord = await page.locator("#admin-main").evaluate((node) => node.scrollTop);
  assert.ok(beforeRecord > 100, "Record-return proof starts at a meaningful list position");
  await page.waitForFunction(({ key, top: expected }) => {
    const saved = JSON.parse(localStorage.getItem(key) || "null")?.current?.scrollTop;
    return Math.abs(saved - expected) < 2;
  }, { key: storageKey, top: beforeRecord });
  await recordScroll(page, report, storageKey, `${kind} before record`);
  await row.evaluate((node, key) => {
    globalThis.__tableViewPointer = null;
    node.addEventListener("pointerdown", () => {
      const main = document.getElementById("admin-main");
      globalThis.__tableViewPointer = {
        stage: "record pointerdown",
        actual: main.scrollTop,
        maximum: main.scrollHeight - main.clientHeight,
        stored: JSON.parse(localStorage.getItem(key) || "null")?.current?.scrollTop,
      };
    }, { capture: true, once: true });
  }, storageKey);
  await row.click();
  if (kind === "customers") await page.getByRole("tab", { name: "Details", exact: true }).waitFor();
  else await page.getByRole("button", { name: "Close", exact: true }).waitFor();
  report.scrollTrace.push(await page.evaluate(() => globalThis.__tableViewPointer));
  await recordScroll(page, report, storageKey, `${kind} record visible`);
  await page.locator("#admin-main").evaluate((node) => node.scrollTo({ top: 200, behavior: "instant" }));
  await recordScroll(page, report, storageKey, `${kind} record scrolled`);
  await page.getByRole("button", { name: kind === "customers" ? "All customers" : "Close", exact: true }).click();
  await pager.getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await recordScroll(page, report, storageKey, `${kind} list visible`);
  await assertScroll(page, beforeRecord, storageKey, `${kind} record return`);

  // Exercise a real shell link and browser Back, including the shell's own
  // pathname scroll reset and a new table component instance.
  let mobileMenu;
  if (report.width === 390) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    mobileMenu = page.getByRole("dialog", { name: "Admin menu", exact: true });
    await mobileMenu.getByRole("link", { name: spec.away, exact: true }).click();
  } else {
    await page.getByRole("link", { name: spec.away, exact: true }).click();
  }
  await page.waitForURL((location) => location.pathname !== spec.path);
  if (mobileMenu) await mobileMenu.waitFor({ state: "hidden" });
  await page.goBack();
  await search.waitFor();
  await pager.getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await assertScroll(page, beforeRecord, storageKey, `${kind} route return`);

  // A second tab starts before the save, reproducing the stale-catalog case.
  const other = await context.newPage();
  other.on("pageerror", (error) => report.errors.push(error.message));
  await other.goto(url);
  const otherSearch = other.getByRole("searchbox", { name: `${spec.label} search`, exact: true });
  await otherSearch.waitFor();
  await other.getByRole("navigation", { name: `${spec.label} pagination`, exact: true })
    .getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await other.getByRole("button", { name: spec.row, exact: true }).waitFor();
  const dialog = await openViews(page, spec.label);
  await dialog.getByRole("textbox", { name: "View name", exact: true }).fill("Working list");
  await screenshot(page, report, `${kind}-save-view`);
  await dialog.getByRole("button", { name: "Save current view", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await pager.getByText(`Page 2 of ${spec.total}`, { exact: true }).waitFor();
  await otherSearch.fill("No matching sample");
  assert.equal(await otherSearch.inputValue(), "No matching sample");
  await pager.getByRole("combobox").selectOption("50");
  await search.fill("No matching sample");
  await openViews(page, spec.label);
  await dialog.getByRole("combobox", { name: `${spec.label} saved view`, exact: true }).selectOption({ label: "Working list" });
  await dialog.getByRole("button", { name: "Use view", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await pager.getByText(`Page 1 of ${spec.total}`, { exact: true }).waitFor();
  await page.getByRole("button", {
    name: kind === "customers" ? "Open Customer Example 001 customer profile" : "Open Example project 001", exact: true,
  }).waitFor();
  assert.equal(await pager.getByRole("combobox").inputValue(), "25");
  assert.equal(await search.inputValue(), "Example");
  assert.equal(await page.locator(spec.column).count(), 0);
  report.geometry.push(await geometry(page, spec.label));
  await screenshot(page, report, `${kind}-applied-view`);
  await openViews(page, spec.label);
  await dialog.getByRole("combobox").selectOption({ label: "Working list" });
  await dialog.getByRole("button", { name: "Delete view", exact: true }).click();
  await dialog.getByText("View deleted.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await otherSearch.fill("Example");
  const otherDialog = await openViews(other, spec.label);
  await otherDialog.getByText("No saved views yet.", { exact: true }).waitFor();
  await openViews(page, spec.label);
  await dialog.getByRole("textbox", { name: "View name", exact: true }).fill("Concurrent first");
  await otherDialog.getByRole("textbox", { name: "View name", exact: true }).fill("Concurrent second");
  const firstSave = dialog.getByRole("button", { name: "Save current view", exact: true });
  const secondSave = otherDialog.getByRole("button", { name: "Save current view", exact: true });
  await Promise.all([firstSave.click({ trial: true }), secondSave.click({ trial: true })]);

  // Keep a real catalog readwrite transaction active. The chained reads hold
  // the object store's transaction queue until the harness explicitly stops
  // adding requests, so both tabs contend on the same primitive as production.
  await other.evaluate(({ databaseName, storeName, key }) => new Promise((ready, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error || new Error("Catalog database did not open"));
    open.onsuccess = () => {
      const database = open.result;
      let released = false;
      let transaction;
      try {
        transaction = database.transaction(storeName, "readwrite");
      } catch (error) {
        database.close();
        reject(error);
        return;
      }
      const store = transaction.objectStore(storeName);
      const completed = new Promise((resolveComplete, rejectComplete) => {
        transaction.oncomplete = () => { database.close(); resolveComplete(); };
        transaction.onabort = () => {
          database.close();
          rejectComplete(transaction.error || new Error("Held catalog transaction aborted"));
        };
      });
      globalThis.releaseCatalogTransaction = () => { released = true; return completed; };
      const keepAlive = () => {
        const read = store.get(key);
        read.onsuccess = () => { if (!released) keepAlive(); };
      };
      keepAlive();
      ready();
    };
  }), { databaseName: "waves-admin-table-views", storeName: "catalogs", key: storageKey });
  await Promise.all([
    firstSave.click(),
    secondSave.click(),
  ]);
  await Promise.all([
    page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Save current view" && button.disabled)),
    other.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Save current view" && button.disabled)),
  ]);
  assert.equal(await dialog.isVisible(), true, "First save stays pending behind the catalog transaction");
  assert.equal(await otherDialog.isVisible(), true, "Second save stays pending behind the catalog transaction");
  assert.equal(await firstSave.isDisabled(), true);
  assert.equal(await secondSave.isDisabled(), true);
  await other.evaluate(() => globalThis.releaseCatalogTransaction());
  await Promise.all([dialog.waitFor({ state: "hidden" }), otherDialog.waitFor({ state: "hidden" })]);
  const verifier = await context.newPage();
  verifier.on("pageerror", (error) => report.errors.push(error.message));
  await verifier.goto(url);
  await verifier.getByRole("searchbox", { name: `${spec.label} search`, exact: true }).waitFor();
  const durableNames = await verifier.evaluate(({ databaseName, storeName, key }) => new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => reject(open.error || new Error("Catalog database did not reopen"));
    open.onsuccess = () => {
      const database = open.result;
      try {
        const transaction = database.transaction(storeName, "readonly");
        const read = transaction.objectStore(storeName).get(key);
        let names = [];
        read.onsuccess = () => {
          names = Array.isArray(read.result?.views)
            ? read.result.views.map((view) => view.name).sort()
            : [];
        };
        transaction.oncomplete = () => { database.close(); resolve(names); };
        transaction.onabort = () => { database.close(); reject(transaction.error || read.error); };
      } catch (error) {
        database.close();
        reject(error);
      }
    };
  }), { databaseName: "waves-admin-table-views", storeName: "catalogs", key: storageKey });
  assert.deepEqual(durableNames, ["Concurrent first", "Concurrent second"]);
  await verifier.close();
  await other.close();

  report.userId = "fixture-other-admin";
  await page.reload();
  await search.waitFor();
  assert.equal(await search.inputValue(), "", "A different verified account starts with its own defaults");
  assert.equal(await pager.getByRole("combobox").inputValue(), "100");
  await openViews(page, spec.label);
  await dialog.getByText("No saved views yet.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  report.userId = "fixture-admin";
  await page.goto(`${server.baseUrl}${spec.path}`);
  await search.waitFor();
  assert.equal(await search.inputValue(), "", "Default-off route does not restore preview preferences");
  assert.equal(await page.getByRole("button", { name: `${spec.label} saved views`, exact: true }).count(), 0);
  report.savedViews = { ...report.savedViews, [kind]: { reload: true, recordReturn: true, routeReturn: true, namedViews: true, crossTab: true, concurrentSaves: true, accountIsolation: true, previewOff: true } };
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
          await context.addInitScript(() => {
            localStorage.setItem("waves_admin_token", "synthetic-local-token");
            localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-admin", role: "admin", name: "Fixture operator" }));
            if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: "synthetic" });
            Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
            const browserFetch = globalThis.fetch.bind(globalThis);
            globalThis.fetch = (resource, options) => {
              const requestUrl = typeof resource === "string" ? resource : resource.url;
              if (new URL(requestUrl, location.origin).pathname === "/api/admin/usage/track") {
                return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
              }
              return browserFetch(resource, options);
            };
          });
          page.on("pageerror", (error) => scenario.errors.push(error.message));
          await context.route("**/*", (route) => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io")) return route.abort();
            if (!url.pathname.startsWith("/api/")) return route.continue();
            const body = fixtures(url, request.method(), scenario);
            if (body === undefined) scenario.unmatched.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({ status: body === undefined ? 404 : 200, contentType: "application/json", body: JSON.stringify(body ?? { error: "Unexpected synthetic request" }) });
          });
          try {
            if (savedViewsScenario) {
              if (checkCustomers) await exerciseSavedViews(page, context, server, scenario, "customers");
              if (checkBids) await exerciseSavedViews(page, context, server, scenario, "bids");
            } else {
              if (checkCustomers) await exerciseCustomers(page, server, scenario);
              if (checkBids) await exerciseBids(page, server, scenario);
            }
            assert.deepEqual(scenario.errors, []);
            assert.deepEqual(scenario.unmatched, []);
          } catch (error) {
            await captureFailure(page, scenario, error);
            throw error;
          }
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
