"use strict";
/* global document, localStorage, navigator, getComputedStyle, NodeFilter */
// Frontend-only regression proof for the mobile payout/bid screenshots.
// Every API response is synthetic; external requests and sockets are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-readable-tables");
const payouts = [
  { id: "payout-example", amount: 12345.67, status: "paid", created_at_stripe: "2026-09-08T14:00:00Z", arrival_date: "2026-09-09", transaction_count: 2, fee_total: 34.56, reconciled: false },
  { id: "payout-second", amount: 2345, status: "pending", created_at_stripe: "2026-09-09T14:00:00Z", arrival_date: "2026-09-10", transaction_count: 0, fee_total: 0, reconciled: true },
];
const bid = {
  id: "bid-example", source: "bluebook", status: "new", historical: true,
  project_title: "Example County Government Building Maintenance and Pest Control",
  package_name: "Annual service agreement", gc_or_agency: "Example Coastal Facilities Group",
  buyer_name: "Avery Example", buyer_email: "avery@example.test", location: "Example County, FL",
  due_at: "2026-09-09T21:00:00Z", due_source_line: "Submit by September 9, 2026 at 5:00 PM Eastern",
  due_confirmed: false, needs_date_confirmation: true, days_left: -46,
  email_count: 1, first_subject: "Example maintenance bid", updated_at: "2026-09-01T12:00:00Z",
};
const projectTitle = `${bid.project_title}: ${bid.package_name}`;

function fixtures(url, method) {
  if (method === "POST" && url.pathname === "/api/admin/usage/track") return { ok: true };
  if (method !== "GET") return undefined;
  switch (url.pathname) {
    case "/api/admin/auth/me": return { id: "fixture-admin", role: "admin", name: "Fixture operator" };
    case "/api/admin/feature-flags": return { flags: {} };
    case "/api/admin/notifications/unread-count": return { count: 0 };
    case "/api/admin/communications/unread-count": return { count: 0, conversations: 0 };
    case "/api/admin/banking/balance": return { total_available: 1500, total_pending: 100, total_instant_available: 500, next_payout: { amount: 1234.56, arrival_date: "2026-09-09" } };
    case "/api/admin/banking/stats": return { mtd_deposited: 14690.67, payout_count: 2 };
    case "/api/admin/banking/payouts": return { payouts, pages: 1 };
    case "/api/admin/banking/payouts/payout-example": return {
      payout: payouts[0], transactions: [{ id: "transaction-example", amount: 120, fee: 3.48, net: 116.52, type: "charge", description: "Synthetic scheduled service invoice payment", customer_name: "Avery Example", created: "2026-09-08T14:00:00Z" }],
    };
    case "/api/admin/banking/reconciliation": return { payouts: [{ ...payouts[0], expected_amount: 12345.67 }] };
    case "/api/admin/bid-desk/": return { bids: [bid, { ...bid, id: "bid-second", historical: false, due_confirmed: true, needs_date_confirmation: false, source: "buildingconnected", project_title: "Example Park Service", package_name: null, days_left: 12 }] };
    case "/api/admin/bid-desk/bid-example": return { bid, emails: [{ email_id: "email-example", kind: "invite", subject: "Example maintenance bid", from_name: "Avery Example", received_at: "2026-09-01T12:00:00Z" }] };
    default: return undefined;
  }
}

async function openPage(browser, server, viewport, touch, report) {
  const context = await browser.newContext({ viewport, hasTouch: touch, timezoneId: "America/New_York", serviceWorkers: "block" });
  await context.routeWebSocket("**/socket.io/**", (socket) => socket.close());
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem("waves_admin_token", "synthetic-local-token");
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-admin", role: "admin", name: "Fixture operator" }));
    if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: "synthetic" });
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io")) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const body = fixtures(url, request.method());
    if (body === undefined) report.unmatched.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: body === undefined ? 404 : 200, contentType: "application/json", body: JSON.stringify(body ?? { error: "Unexpected synthetic request" }) });
  });
  return { page, context };
}

async function geometry(table, { records, singleLine = [] } = {}) {
  const result = await table.evaluate((node, selectors) => {
    const rect = node.getBoundingClientRect();
    const rows = [...node.tBodies[0].rows];
    const lineBoxes = (element) => {
      const boxes = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        boxes.push(...[...range.getClientRects()].filter((box) => box.width > 0).map((box) => ({ top: Math.round(box.top), left: box.left, right: box.right })));
      }
      return boxes;
    };
    const splitWords = (element) => {
      const broken = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        for (const match of text.textContent.matchAll(/[A-Za-z]{3,}|\$[\d,.]+|\d{1,4}\/\d{1,2}\/\d{1,4}/g)) {
          if (match[0].length > 40) continue; // An exceptional identifier may need a fallback break.
          const range = document.createRange();
          range.setStart(text, match.index);
          range.setEnd(text, match.index + match[0].length);
          if (new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size > 1) broken.push(match[0]);
        }
      }
      return broken;
    };
    return {
      table: { left: rect.left, right: rect.right, width: rect.width },
      viewport: document.documentElement.clientWidth,
      rows: rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        return { height: bounds.height, left: bounds.left, right: bounds.right, display: getComputedStyle(row).display };
      }),
      cells: rows.flatMap((row) => [...row.cells]).map((cell) => {
        const bounds = cell.getBoundingClientRect();
        return { text: cell.textContent.trim().slice(0, 90), left: bounds.left, right: bounds.right, scrollWidth: cell.scrollWidth, width: cell.clientWidth, boxes: lineBoxes(cell), splitWords: splitWords(cell) };
      }),
      values: selectors.flatMap((selector) => [...node.querySelectorAll(selector)].map((element) => ({ selector, text: element.textContent.trim(), boxes: lineBoxes(element) }))),
      controls: [...node.querySelectorAll("button")].map((button) => {
        const bounds = button.getBoundingClientRect(), style = getComputedStyle(button);
        return { text: button.textContent.trim(), width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right, font: parseFloat(style.fontSize), appearance: style.appearance || style.webkitAppearance };
      }),
    };
  }, singleLine);
  if (records) {
    assert.ok(result.table.left >= -1 && result.table.right <= result.viewport + 1, "Record table must fit the page");
    for (const cell of result.cells) {
      assert.ok(cell.left >= result.table.left - 1 && cell.right <= result.table.right + 1, `Cell leaves its record: ${JSON.stringify(cell)}`);
      assert.ok(cell.scrollWidth <= cell.width + 1, `Clipped content inside record: ${JSON.stringify(cell)}`);
    }
  }
  for (const value of result.values) assert.ok(new Set(value.boxes.map((box) => box.top)).size <= 1, `Atomic value wrapped: ${value.text}`);
  // A table can fit the page while text still paints across adjacent columns.
  for (const cell of result.cells) {
    for (const box of cell.boxes) assert.ok(box.left >= cell.left - 1 && box.right <= cell.right + 1, `Text leaves its cell: ${cell.text}`);
    assert.deepEqual(cell.splitWords, [], `Words or amounts fragmented: ${cell.text}`);
  }
  for (const control of result.controls) {
    assert.ok(control.height >= 43.5, `Touch action too short: ${JSON.stringify(control)}`);
    assert.ok(control.font >= 14, `Small action text: ${JSON.stringify(control)}`);
    assert.equal(control.appearance, "none", `Native button styling: ${control.text}`);
  }
  return result;
}

async function shot(page, report, name, target) {
  await target.scrollIntoViewIfNeeded();
  // The shell animates its sidebar after crossing the desktop breakpoint.
  await page.waitForTimeout(350);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(path.relative(root, file));
}

async function resize(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(350);
}

async function exercise(page, server, report, device) {
  await page.goto(`${server.baseUrl}/admin/banking`);
  const payoutButton = page.getByRole("button", { name: "Payout payout-example", exact: true });
  await payoutButton.waitFor();
  await waitForFonts(page);
  const commandStyle = await page.locator(".ui-command-action").first().evaluate((node) => ({ transform: getComputedStyle(node).textTransform, appearance: getComputedStyle(node).appearance }));
  assert.equal(commandStyle.transform, "none", "Header actions use the same sentence case as other buttons");
  assert.equal(commandStyle.appearance, "none", "Header action keeps authored styling in WebKit");
  const payoutsTable = payoutButton.locator("xpath=ancestor::table[1]");
  const viewport = page.viewportSize();
  for (const width of [320, 390, 700, 820, 1024, 1100, 1101, 1440]) {
    await resize(page, { width, height: width < 700 ? 844 : 1000 });
    report.geometry.push({ device, surface: "Payouts", width, ...await geometry(payoutsTable, { records: width <= 1100, singleLine: [".banking-payout-amount", ".banking-payout-date button", ".banking-payout-status", ".banking-payout-fees"] }) });
  }
  await resize(page, viewport);
  await shot(page, report, `${device}-payouts`, payoutsTable);
  await payoutButton.click();
  const transactions = page.getByRole("table", { name: "Transactions for payout payout-example", exact: true });
  await transactions.waitFor();
  assert.equal(await payoutButton.getAttribute("aria-expanded"), "true");
  for (const width of [320, 390, 820, 1440]) {
    await resize(page, { width, height: width < 700 ? 844 : 1000 });
    report.geometry.push({ device, surface: "Transactions", width, ...await geometry(transactions, { records: width <= 1100, singleLine: ['td[data-label="Amount"]', 'td[data-label="Fee"]', 'td[data-label="Net"]'] }) });
  }
  await resize(page, viewport);
  await shot(page, report, `${device}-transactions`, transactions);
  await payoutButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(await payoutButton.getAttribute("aria-expanded"), "false", "Keyboard closes transaction details");
  await page.keyboard.press("Space");
  assert.equal(await payoutButton.getAttribute("aria-expanded"), "true", "Keyboard reopens transaction details");

  // A financial comparison keeps the default scrolling table presentation.
  await page.getByRole("button", { name: "Exports", exact: true }).click();
  const exportTable = page.getByRole("table");
  await exportTable.getByText("$12,345.67", { exact: true }).waitFor();
  for (const width of [320, 390, 1440]) {
    await resize(page, { width, height: width < 700 ? 844 : 1000 });
    report.geometry.push({ device, surface: "Export preview", width, ...await geometry(exportTable, { singleLine: ["tbody tr td:nth-child(2)", "tbody tr td:nth-child(3)"] }) });
  }
  await resize(page, viewport);

  await page.goto(`${server.baseUrl}/admin/bid-desk`);
  const projectButton = page.getByRole("button", { name: `Open ${projectTitle}`, exact: true });
  await projectButton.waitFor();
  await waitForFonts(page);
  const bidsTable = projectButton.locator("xpath=ancestor::table[1]");
  for (const width of [320, 390, 700, 820, 1024, 1100, 1101, 1440]) {
    await resize(page, { width, height: width < 700 ? 844 : 1000 });
    report.geometry.push({ device, surface: "Bids", width, ...await geometry(bidsTable, { records: width <= 1100, singleLine: ['td[data-label="Deadline"]', 'td[data-label="Status"]', '.whitespace-nowrap'] }) });
  }
  await resize(page, { width: 1101, height: 1000 });
  const scrollport = bidsTable.locator("..");
  assert.equal(await scrollport.getAttribute("tabindex"), "0", "Wide tables are keyboard reachable");
  await scrollport.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(350);
  const keyboardScroll = await scrollport.evaluate((node) => ({ active: document.activeElement === node, left: node.scrollLeft, width: node.clientWidth, total: node.scrollWidth, overflow: getComputedStyle(node).overflowX }));
  assert.ok(keyboardScroll.left > 0, `${device}: keyboard scroll ${JSON.stringify(keyboardScroll)}`);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await scrollport.evaluate((node) => node.scrollLeft), 0, "Left arrow restores the leading columns");
  const childKeyPrevented = await projectButton.evaluate((node) => {
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(childKeyPrevented, false, "Table scrolling does not intercept keys from row controls");
  await resize(page, { width: 390, height: 844 });
  assert.equal(await scrollport.getAttribute("tabindex"), null, "Mobile records do not add an unnecessary scroll tab stop");
  await resize(page, viewport);
  await shot(page, report, `${device}-bids`, bidsTable);
  assert.equal(await bidsTable.getByText("Unconfirmed", { exact: true }).count(), 1);
  assert.equal(await bidsTable.getByText("Date may have changed", { exact: true }).count(), 1);
  await projectButton.focus();
  await page.keyboard.press("Enter");
  const dueInput = page.getByLabel("Due date (Eastern time)");
  await dueInput.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("bid"), "bid-example");
  await shot(page, report, `${device}-bid-detail`, dueInput);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get("bid"), null);
  await page.getByRole("button", { name: "Hide earlier mail", exact: true }).click();
  assert.equal(await projectButton.count(), 0, "Earlier bid filter still works");
  await page.getByRole("button", { name: "Show earlier mail", exact: true }).click();
  await projectButton.waitFor();
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, geometry: [], screenshots: [], pageErrors: [], unmatched: [] };
  let server;
  try {
    server = await previewServer(root, process.argv[2]);
    for (const [device, launch, viewport, touch] of [
      ["desktop", launchBrowser, { width: 1440, height: 1000 }, false],
      ["mobile-webkit", () => webkit.launch({ headless: true }), { width: 390, height: 844 }, true],
    ]) {
      const browser = await launch();
      try {
        const { page, context } = await openPage(browser, server, viewport, touch, report);
        try { await exercise(page, server, report, device); } finally { await context.close(); }
      } finally { await browser.close(); }
    }
    assert.deepEqual(report.pageErrors, [], "No uncaught page errors");
    assert.deepEqual(report.unmatched, [], "Every API call has an explicit synthetic fixture");
    report.passed = true;
    console.log(`Readable tables passed: ${report.geometry.length} geometry checks, ${report.screenshots.length} screenshots.`);
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (server) await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
