"use strict";
/* global document, localStorage, navigator, getComputedStyle, innerWidth, requestAnimationFrame */
// Actual finance routes with synthetic API fixtures; external requests are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { webkit } = require("playwright");
const {
  previewServer,
  launchBrowser,
  evidence,
  waitForFonts,
} = require("./browser");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, ".tmp/admin-finance-foundation");
const payout = {
  id: "payout-example",
  amount: 1234.56,
  status: "paid",
  created_at_stripe: "2026-09-08T14:00:00Z",
  arrival_date: "2026-09-09",
  transaction_count: 2,
  fee_total: 34.56,
  reconciled: false,
};
const equipment = {
  id: "equipment-example",
  name: "Example service truck",
  assetCategory: "vehicle",
  purchaseCost: 25000,
  currentBookValue: 20000,
  accumulatedDepreciation: 5000,
  annualDepreciation: 5000,
  purchaseDate: "2026-01-01",
  active: true,
  makeModel: "Example pickup",
  depreciationMethod: "MACRS",
  businessUsePct: 80,
  businessUseConfirmed: false,
  usefulLifeYears: 5,
};
const expense = {
  id: "expense-example",
  categoryId: "category-example",
  categoryName: "Supplies",
  irsLine: "22",
  description: "Synthetic service supplies",
  amount: 100,
  deductibleAmount: 100,
  expenseDate: "2026-09-08",
  vendorName: "Example supplier",
  paymentMethod: "card",
  taxYear: 2026,
};
const filing = {
  id: "filing-example",
  filingType: "1040-ES",
  title: "Synthetic quarterly filing",
  periodLabel: "Q4",
  dueDate: "2099-01-15",
  status: "upcoming",
  amountDue: 500,
};
const pnl = {
  startDate: "2026-09-01",
  endDate: "2026-09-09",
  revenue: { serviceRevenue: 5000, otherRevenue: 0, total: 5000 },
  cogs: { materials: 100, total: 100 },
  grossProfit: 4900,
  grossMargin: 0.98,
  operatingExpenses: {
    categories: [
      { name: "Supplies", category: "Supplies", amount: 100, total: 100 },
    ],
    total: 100,
  },
  netIncome: 4800,
  netMargin: 0.96,
  vehicleDeductionMethod: null,
};
const receivable = {
  id: "invoice-example",
  invoiceNumber: "WPC-QA-001",
  customerName: "Avery Example",
  phone: "9415550100",
  amount: 120,
  dueDate: "2026-08-01",
  daysOverdue: 39,
  bucket: "30",
};
const bankRow = {
  id: "bank-example",
  txn_date: "2026-09-08",
  description: "Synthetic service supplies",
  amount: 100,
  direction: "debit",
  status: "unmatched",
  account_label: "example-checking",
  account_type: "bank",
  suggestion: {
    candidates: [],
    refundCandidates: [],
    payoutCandidates: [],
  },
};
function fixtures(state) {
  return new Map([
    [
      "GET /api/admin/auth/me",
      () => ({
        id: "fixture-admin",
        name: "Fixture operator",
        role: state.role || "admin",
      }),
    ],
    ["GET /api/admin/feature-flags", () => ({ flags: {} })],
    ["GET /api/admin/notifications/unread-count", () => ({ count: 0 })],
    [
      "GET /api/admin/communications/unread-count",
      () => ({ count: 0, conversations: 0 }),
    ],
    ["POST /api/admin/usage/track", () => ({ ok: true })],
    ["POST /api/client-errors", () => ({ ok: true })],
    [
      "GET /api/admin/banking/balance",
      () => ({
        total_available: 1500,
        total_pending: 100,
        total_instant_available: 500,
        next_payout: { amount: 1234.56, arrival_date: "2026-09-09" },
      }),
    ],
    [
      "GET /api/admin/banking/stats",
      () => ({ mtd_deposited: 1234.56, payout_count: 1 }),
    ],
    [
      "GET /api/admin/banking/payouts",
      () => ({ payouts: state.empty ? [] : [payout], pages: 1 }),
    ],
    [
      "GET /api/admin/banking/payouts/payout-example",
      () => ({
        payout,
        transactions: [
          {
            id: "transaction-example",
            amount: 120,
            fee: 3.48,
            net: 116.52,
            type: "charge",
            description: "Synthetic invoice payment",
            customer_name: "Avery Example",
            created: "2026-09-08T14:00:00Z",
          },
        ],
      }),
    ],
    [
      "GET /api/admin/banking/cash-flow",
      () => ({
        periods: [
          {
            period: "2026-09-01",
            label: "Sep 1",
            money_in: 5000,
            money_out: 1000,
            revenue: 5000,
            expenses: 1000,
            inflow: 5000,
            outflow: 1000,
            net: 4000,
          },
        ],
        summary: { total_in: 5000, total_out: 1000, net: 4000 },
      }),
    ],
    [
      "GET /api/admin/banking/reconciliation",
      () => ({
        payouts: state.empty ? [] : [{ ...payout, expected_amount: 1234.56 }],
      }),
    ],
    [
      "POST /api/admin/banking/reconciliation/payout-example",
      () => ({ ok: true }),
    ],
    ["POST /api/admin/banking/payouts/standard", () => ({ ok: true })],
    ["POST /api/admin/banking/payouts/instant", () => ({ ok: true })],
    [
      "GET /api/admin/tax/dashboard",
      () => ({
        ytdTaxCollected: 70,
        expenses: { total: 100, deductible: 100, count: 1 },
        equipment: { bookValue: 20000, count: 1 },
        nextDeadlines: [filing],
        pendingAlerts: { high: 0 },
      }),
    ],
    [
      "GET /api/admin/tax/rates",
      () => ({
        rates: state.empty
          ? []
          : [
              {
                id: "rate-example",
                county: "Example County",
                state: "FL",
                stateRate: 0.06,
                countySurtax: 0.01,
                combinedRate: 0.07,
                effectiveDate: "2026-01-01",
                active: true,
              },
            ],
      }),
    ],
    [
      "GET /api/admin/tax/service-taxability",
      () => ({
        services: state.empty
          ? []
          : [
              {
                id: "service-example",
                serviceKey: "pest",
                serviceLabel: "Example pest control",
                isTaxable: true,
                taxCategory: "residential",
                flStatuteRef: "Synthetic fixture",
              },
            ],
      }),
    ],
    [
      "PUT /api/admin/tax/service-taxability/service-example",
      () => ({ success: true }),
    ],
    [
      "GET /api/admin/tax/equipment",
      () => ({ equipment: state.empty ? [] : [equipment] }),
    ],
    ["POST /api/admin/tax/equipment", () => ({ success: true })],
    [
      "PUT /api/admin/tax/equipment/equipment-example",
      () => ({ success: true }),
    ],
    [
      "GET /api/admin/tax/expense-categories",
      () => ({
        categories: [
          {
            id: "category-example",
            name: "Supplies",
            irsLine: "22",
            isDeductible: true,
          },
        ],
      }),
    ],
    [
      "GET /api/admin/tax/expenses",
      () => ({
        expenses: state.empty ? [] : [expense],
        summary: state.empty
          ? []
          : [{ category: "Supplies", total: 100, deductible: 100, count: 1 }],
      }),
    ],
    ["POST /api/admin/tax/expenses", () => ({ success: true })],
    [
      "POST /api/admin/tax/expenses/auto-categorize",
      () => ({ applied: 1, processed: 1, remaining: 0 }),
    ],
    [
      "GET /api/admin/tax/filings",
      () => ({ filings: state.empty ? [] : [filing] }),
    ],
    ["PUT /api/admin/tax/filings/filing-example", () => ({ success: true })],
    [
      "GET /api/admin/tax/advisor/reports",
      () => ({
        reports: state.empty
          ? []
          : [
              {
                id: "report-example",
                date: "2026-09-08",
                period: "weekly",
                grade: "B",
                summary: "Synthetic report for interface review.",
                financialSnapshot: {},
                regulationChanges: [],
                savingsOpportunities: [],
                deductionGaps: [],
                complianceAlerts: [],
                actionItems: [],
              },
            ],
      }),
    ],
    [
      "GET /api/admin/tax/advisor/alerts",
      () => ({
        alerts: state.empty
          ? []
          : [
              {
                id: "alert-example",
                title: "Review synthetic filing",
                priority: "medium",
                type: "filing",
                description: "Synthetic review item.",
                status: "new",
              },
            ],
        counts: { new: 1 },
      }),
    ],
    ["POST /api/admin/tax/advisor/run", () => ({ success: true })],
    [
      "PUT /api/admin/tax/advisor/alerts/alert-example",
      () => ({ success: true }),
    ],
    [
      "GET /api/admin/tax/exemptions",
      () => ({
        exemptions: state.empty
          ? []
          : [
              {
                id: "exemption-example",
                customerName: "Example Association",
                exemptionType: "nonprofit",
                certificateNumber: "SYNTHETIC-001",
                expiryDate: "2099-12-31",
                active: true,
              },
            ],
      }),
    ],
    [
      "GET /api/admin/tax/mileage",
      () => ({
        entries: state.empty
          ? []
          : [
              {
                id: "trip-example",
                tripDate: "2026-09-08",
                vehicleName: "Example truck",
                startAddress: "Example office",
                endAddress: "Example service site",
                distanceMiles: 12.3,
                purpose: "unclassified",
                irsRate: 0,
                deductionAmount: 0,
                source: "bouncie",
              },
            ],
      }),
    ],
    [
      "GET /api/admin/tax/mileage/stats",
      () => ({
        ytdMiles: 12.3,
        ytdDeduction: 0,
        currentRate: 0.7,
        totalMiles: 12.3,
        totalDeduction: 0,
        totalTrips: 1,
      }),
    ],
    ["POST /api/admin/tax/mileage", () => ({ success: true })],
    [
      "POST /api/admin/tax/mileage/sync-bouncie",
      () => ({ tripsImported: 0, totalMiles: 0, deductionAmount: 0 }),
    ],
    [
      "POST /api/admin/tax/mileage/bulk-classify",
      () => ({ updated: 1, deductionTotal: 8.61 }),
    ],
    [
      "GET /api/admin/tax/revenue/reconcile",
      () => ({
        totalRevenue: 5000,
        taxCollected: 100,
        taxOwed: null,
        difference: null,
      }),
    ],
    [
      "GET /api/admin/tax/revenue/quarterly-estimate",
      () => ({
        quarter: "Q3",
        estimatedTax: 500,
        totalEstimatedTax: 500,
        paidToDate: 0,
        remainingDue: 500,
      }),
    ],
    ["GET /api/admin/tax/pnl", () => pnl],
    ["PUT /api/admin/revenue/settings", () => ({ success: true })],
    [
      "GET /api/admin/tax/accounts-receivable",
      () => ({
        summary: {
          total: 120,
          current: 0,
          over30: 120,
          over60: 0,
          over90: 0,
          count: 1,
        },
        invoices: state.empty ? [] : [receivable],
      }),
    ],
    ["POST /api/admin/sms/send", () => ({ success: true })],
    [
      "GET /api/admin/tax/bank-import/status",
      () => ({ enabled: state.bankImport !== false, counts: { unmatched: 1 } }),
    ],
    [
      "GET /api/admin/tax/bank-import/transactions",
      () => ({ transactions: state.empty ? [] : [bankRow], hasMore: false }),
    ],
    [
      "GET /api/admin/tax/bank-import/coverage",
      () => ({
        months: [
          {
            month: "2026-09",
            account_label: "example-checking",
            row_count: 1,
            pct: 0,
            unexplained: 100,
            total_debits: 100,
            total_credits: 0,
          },
        ],
      }),
    ],
    [
      "POST /api/admin/tax/bank-import/upload",
      () => ({
        imported: 1,
        parsed: 1,
        duplicates: 0,
        skipped: [],
        skippedTotal: 0,
      }),
    ],
    [
      "POST /api/admin/tax/bank-import/bank-example/create-expense",
      () => ({ success: true }),
    ],
    [
      "POST /api/admin/tax/bank-import/bank-example/ignore",
      () => ({ success: true }),
    ],
  ]);
}
async function install(page, server, state) {
  const handlers = fixtures(state);
  await page.addInitScript(() => {
    localStorage.setItem("waves_admin_token", "synthetic-token");
    localStorage.setItem(
      "waves_admin_user",
      JSON.stringify({
        id: "fixture-admin",
        role: "admin",
        name: "Fixture operator",
      }),
    );
    if (navigator.serviceWorker)
      navigator.serviceWorker.register = async () => ({ scope: "synthetic" });
  });
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (m) => {
    if (m.type() === "error")
      state.consoleErrors.push({ text: m.text(), url: m.location().url });
  });
  page.on("dialog", (dialog) =>
    dialog.accept(dialog.type() === "prompt" ? "80" : undefined),
  );
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io"))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {}
    state.requests.push({ key, query: url.search, body });
    if (state.hold?.key === key) await state.hold.promise;
    if (state.failures.has(key)) {
      if (request.method() !== "GET") state.failures.delete(key);
      state.expectedFailures.push(url.href);
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic request failed. Try again." }),
      });
    }
    if (
      key === "GET /api/admin/banking/export" ||
      url.pathname.startsWith("/api/admin/tax/export/")
    )
      return route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "date,amount\n2026-09-08,100\n",
      });
    if (!handlers.has(key)) {
      state.unmatched.push(key);
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Unmatched synthetic fixture"}',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(handlers.get(key)(url, body)),
    });
  });
}
async function shot(page, report, name) {
  await page.waitForTimeout(400);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(path.relative(root, file));
}
async function geometry(page, state, surface) {
  const data = await page.evaluate(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector("main .ui-surface");
    if (!root) throw Error("Surface missing");
    const visible = (n) =>
      n.getClientRects().length > 0 && !n.closest("[hidden],[inert]");
    const inScrollable = (n) => !!n.closest(".ui-table,.ui-workspace-nav");
    const controls = [
      ...root.querySelectorAll(
        'button,input:not([type="checkbox"]):not([type="file"]),select,textarea,a',
      ),
    ]
      .filter(visible)
      .map((n) => {
        const r = n.getBoundingClientRect(),
          s = getComputedStyle(n);
        return {
          name:
            n.getAttribute("aria-label") ||
            n.labels?.[0]?.textContent ||
            n.textContent.trim(),
          height: r.height,
          width: r.width,
          left: r.left,
          right: r.right,
          font: parseFloat(s.fontSize),
          scrollable: inScrollable(n),
          labeled:
            !["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName) ||
            [...(n.labels || [])].some((l) => l.textContent.trim()) ||
            !!n.getAttribute("aria-label"),
        };
      });
    const smallText = [...root.querySelectorAll("*")]
      .filter(visible)
      .filter((n) =>
        [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()),
      )
      .filter((n) => parseFloat(getComputedStyle(n).fontSize) < 14)
      .map((n) => n.textContent.slice(0, 80));
    return {
      controls,
      smallText,
      pageWidth: document.querySelector("main .ui-surface").getBoundingClientRect().width,
      numbers: [...root.querySelectorAll(".u-nums")].filter(visible).map((node) => ({
        font: getComputedStyle(node).fontFamily,
        numerals: getComputedStyle(node).fontVariantNumeric,
      })),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      title: parseFloat(
        getComputedStyle(document.querySelector("main h1")).fontSize,
      ),
    };
  });
  state.geometry.push({ surface, viewport: page.viewportSize(), ...data });
  assert.equal(data.overflow, false, `${surface}: document overflow`);
  assert.ok(data.pageWidth <= 1300.5, `${surface}: page width ${data.pageWidth}`);
  for (const numeric of data.numbers) {
    assert.ok(numeric.font.includes("Roboto"), `${surface}: numeric font ${numeric.font}`);
    assert.ok(numeric.numerals.includes("tabular-nums"), `${surface}: numeric alignment ${numeric.numerals}`);
  }
  assert.deepEqual(data.smallText, [], `${surface}: small text`);
  assert.equal(data.title, 22, `${surface}: title`);
  for (const c of data.controls) {
    assert.ok(c.height >= 43.5, `${surface}: height ${JSON.stringify(c)}`);
    assert.ok(c.font >= 14, `${surface}: font ${JSON.stringify(c)}`);
    assert.ok(c.labeled, `${surface}: label ${JSON.stringify(c)}`);
    if (!c.scrollable)
      assert.ok(
        c.left >= -1 && c.right <= page.viewportSize().width + 1,
        `${surface}: bounds ${JSON.stringify(c)}`,
      );
  }
}
async function widths(page, state, surface) {
  const original = page.viewportSize();
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 700, height: 1000 },
    { width: 820, height: 1000 },
    { width: 1024, height: 1000 },
    { width: 1440, height: 1000 },
    { width: 1920, height: 1080 },
    { width: 844, height: 390 },
    { width: 390, height: 420 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await geometry(page, state, surface);
  }
  await page.setViewportSize(original);
}
async function bankSection(page, name) {
  await page
    .getByRole("navigation", { name: "Banking section", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await page.waitForTimeout(100);
}
async function taxSection(page, group, leaf) {
  await page
    .getByRole("navigation", { name: "Taxes section", exact: true })
    .getByRole("button", { name: group, exact: true })
    .click();
  if (leaf)
    await page
      .locator("main")
      .getByRole("button", { name: leaf, exact: true })
      .click();
  await page.waitForTimeout(150);
}
async function views(page, server, state, report, device) {
  await page.goto(`${server.baseUrl}/admin/banking`);
  await page
    .getByRole("button", { name: "Payout payout-example", exact: true })
    .waitFor();
  await waitForFonts(page);
  for (const section of ["Payouts", "Cash Flow", "Reconciliation", "Exports"]) {
    await bankSection(page, section);
    await widths(page, state, `Banking ${section}`);
    await shot(
      page,
      report,
      `${device}-banking-${section.toLowerCase().replaceAll(" ", "-")}`,
    );
  }
  await bankSection(page, "Payouts");
  const payoutButton = page.getByRole("button", {
    name: "Payout payout-example",
    exact: true,
  });
  const payoutRow = payoutButton.locator("xpath=ancestor::tr");
  await payoutRow.getByText("$1,234.56", { exact: true }).click();
  await page.getByText("Synthetic invoice payment", { exact: true }).waitFor();
  assert.equal(await payoutButton.getAttribute("aria-expanded"), "true");
  await payoutButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await payoutButton.getAttribute("aria-expanded"),
    "false",
    "Keyboard closes the row once",
  );
  await page.keyboard.press("Space");
  assert.equal(
    await payoutButton.getAttribute("aria-expanded"),
    "true",
    "Keyboard opens the row once",
  );
  await payoutButton.click();
  assert.equal(
    await payoutButton.getAttribute("aria-expanded"),
    "false",
    "Date click closes the row once",
  );
  await payoutRow.getByText("paid", { exact: true }).click();
  await page.getByText("Synthetic invoice payment", { exact: true }).waitFor();
  await widths(page, state, "Payout transactions");
  await shot(page, report, `${device}-banking-transactions`);
  for (const [method, openerIndex, surface] of [
    ["Standard", 0, "Header standard"],
    ["Standard", 1, "Standard"],
    ["Instant", 0, "Instant"],
  ]) {
    const open = page
      .getByRole("button", { name: `${method} Payout`, exact: true })
      .nth(openerIndex);
    await open.click();
    const dialog = page.getByRole("dialog", {
      name: "Transfer Stripe Balance",
      exact: true,
    });
    await dialog.waitFor();
    await widths(page, state, `${surface} payout`);
    await shot(
      page,
      report,
      `${device}-payout-${surface.toLowerCase().replaceAll(" ", "-")}`,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await open.evaluate((n) => document.activeElement === n),
      true,
      "Payout opener focus",
    );
  }
  await page.goto(`${server.baseUrl}/admin/tax`);
  await page.getByText("Tax Collected YTD", { exact: true }).waitFor();
  await waitForFonts(page);
  for (const [group, leaf, key] of [
    ["Overview", null, "overview"],
    ["Tax Setup", "Tax Rates", "rates"],
    ["Tax Setup", "Taxability", "services"],
    ["Tax Setup", "Exemptions", "exemptions"],
    ["Expenses", null, "expenses"],
    ["Expenses", "Bank Import", "bank-import"],
    ["Revenue", null, "revenue"],
    ["Assets", null, "equipment"],
    ["Assets", "Mileage", "mileage"],
    ["Reports", null, "pnl"],
    ["Reports", "Filing Calendar", "filings"],
    ["Reports", "AI Advisor", "advisor"],
    ["Exports & A/R", null, "exports"],
    ["Exports & A/R", "A/R", "receivables"],
  ]) {
    await taxSection(page, group, leaf);
    await widths(page, state, `Taxes ${key}`);
    await shot(page, report, `${device}-tax-${key}`);
    if (["bank-import", "mileage", "pnl", "equipment"].includes(key)) {
      await page
        .locator("main")
        .evaluate((n) =>
          n.scrollTo({ top: n.scrollHeight, behavior: "instant" }),
        );
      await shot(page, report, `${device}-tax-${key}-bottom`);
      await page
        .locator("main")
        .evaluate((n) => n.scrollTo({ top: 0, behavior: "instant" }));
    }
    console.log(`${device}: ${key}`);
  }
  for (const [group, label, key] of [
    ["Assets", "+ Add Equipment", "equipment"],
    ["Expenses", "+ Add Expense", "expense"],
  ]) {
    await taxSection(page, group);
    await page.getByRole("button", { name: label, exact: true }).click();
    await widths(page, state, `Add ${key}`);
    await shot(page, report, `${device}-add-${key}`);
  }
}
async function retryWrite(page, state, key, submit, verify) {
  const before = state.requests.filter((r) => r.key === key).length;
  state.failures.add(key);
  let release;
  state.hold = {
    key,
    promise: new Promise((r) => {
      release = r;
    }),
  };
  state.hold.release = release;
  await submit();
  await page.waitForFunction(
    () =>
      !!document.querySelector(
        '[aria-busy="true"],button:disabled,select:disabled,input:disabled',
      ),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    state.requests.filter((r) => r.key === key).length,
    before + 1,
    key + " single pending write",
  );
  release();
  state.hold = null;
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic request failed" })
    .waitFor();
  if (verify) await verify();
  const first = state.requests.filter((r) => r.key === key).at(-1).body;
  await submit();
  await page.waitForTimeout(250);
  assert.equal(
    state.requests.filter((r) => r.key === key).length,
    before + 2,
    key + " retry",
  );
  assert.deepEqual(
    state.requests.filter((r) => r.key === key).at(-1).body,
    first,
    key + " preserved payload",
  );
  console.log(key + " retry passed");
}
async function workflows(page, server, state, report, device) {
  await page.goto(`${server.baseUrl}/admin/banking`);
  await page
    .getByRole("button", { name: "Payout payout-example", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Payout payout-example", exact: true })
    .waitFor();
  for (const method of ["Standard", "Instant"]) {
    await page
      .getByRole("button", { name: method + " Payout", exact: true })
      .last()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Payout Amount", { exact: true }).fill("125");
    await retryWrite(
      page,
      state,
      `POST /api/admin/banking/payouts/${method.toLowerCase()}`,
      () =>
        dialog
          .getByRole("button", { name: "Confirm " + method, exact: true })
          .click(),
      async () => {
        assert.equal(
          await dialog
            .getByLabel("Payout Amount", { exact: true })
            .inputValue(),
          "125",
        );
        await shot(page, report, `${device}-${method.toLowerCase()}-retry`);
      },
    );
    await dialog.waitFor({ state: "hidden" });
  }
  await bankSection(page, "Reconciliation");
  await page.getByLabel("Actual Amount", { exact: true }).fill("119.50");
  await page
    .getByLabel("Notes", { exact: true })
    .fill("Synthetic preserved note");
  await retryWrite(
    page,
    state,
    "POST /api/admin/banking/reconciliation/payout-example",
    () => page.getByRole("button", { name: "Reconcile", exact: true }).click(),
    async () =>
      assert.equal(
        await page.getByLabel("Notes", { exact: true }).inputValue(),
        "Synthetic preserved note",
      ),
  );
  await page.goto(`${server.baseUrl}/admin/tax`);
  await page.getByText("Tax Collected YTD", { exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Banking", exact: true }).waitFor();
  await page.goForward();
  await page.getByText("Tax Collected YTD", { exact: true }).waitFor();
  for (const [group, label, key, fields] of [
    [
      "Expenses",
      "+ Add Expense",
      "expenses",
      {
        "Description *": "Synthetic expense",
        "Amount *": "85.50",
        "Date *": "2099-01-01",
      },
    ],
    [
      "Assets",
      "+ Add Equipment",
      "equipment",
      { "Name *": "Synthetic asset", "Cost *": "2500" },
    ],
  ]) {
    await taxSection(page, group);
    await page.getByRole("button", { name: label, exact: true }).click();
    for (const [name, value] of Object.entries(fields))
      await page.getByLabel(name, { exact: true }).fill(value);
    await retryWrite(
      page,
      state,
      "POST /api/admin/tax/" + key,
      () => page.getByRole("button", { name: "Save", exact: true }).click(),
      async () => {
        for (const [name, value] of Object.entries(fields))
          assert.equal(
            await page.getByLabel(name, { exact: true }).inputValue(),
            value,
          );
        await shot(page, report, `${device}-${key}-retry`);
      },
    );
  }
  await taxSection(page, "Assets", "Mileage");
  await page.getByLabel("From", { exact: true }).fill("Example office");
  await page.getByLabel("To", { exact: true }).fill("Example site");
  await page.getByLabel("Miles", { exact: true }).fill("12.3");
  await retryWrite(
    page,
    state,
    "POST /api/admin/tax/mileage",
    () => page.getByRole("button", { name: "+ Add", exact: true }).click(),
    async () =>
      assert.equal(
        await page.getByLabel("From", { exact: true }).inputValue(),
        "Example office",
      ),
  );
  await page.getByLabel("Select trip", { exact: true }).check();
  await retryWrite(
    page,
    state,
    "POST /api/admin/tax/mileage/bulk-classify",
    () => page.getByRole("button", { name: /Mark business/i }).click(),
    async () =>
      assert.equal(
        await page.getByLabel("Select trip", { exact: true }).isChecked(),
        true,
      ),
  );
  await taxSection(page, "Reports", "Filing Calendar");
  await retryWrite(
    page,
    state,
    "PUT /api/admin/tax/filings/filing-example",
    () =>
      page.getByLabel("Filing status", { exact: true }).selectOption("paid"),
  );
  await taxSection(page, "Expenses", "Bank Import");
  await page
    .getByLabel("Account label", { exact: true })
    .fill("example-checking");
  const file = {
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Date,Description,Amount\n2026-09-08,Synthetic supplies,-100\n",
    ),
  };
  await retryWrite(
    page,
    state,
    "POST /api/admin/tax/bank-import/upload",
    () => page.locator('input[type="file"]').setInputFiles(file),
    async () =>
      assert.equal(
        await page.getByLabel("Account label", { exact: true }).inputValue(),
        "example-checking",
      ),
  );
  await page
    .getByLabel("Expense category", { exact: true })
    .selectOption("category-example");
  await retryWrite(
    page,
    state,
    "POST /api/admin/tax/bank-import/bank-example/create-expense",
    () =>
      page.getByRole("button", { name: "Create expense", exact: true }).click(),
    async () =>
      assert.equal(
        await page.getByLabel("Expense category", { exact: true }).inputValue(),
        "category-example",
      ),
  );
  await retryWrite(
    page,
    state,
    "POST /api/admin/tax/bank-import/bank-example/ignore",
    () => page.getByRole("button", { name: "Ignore", exact: true }).click(),
  );
  await shot(page, report, `${device}-bank-import-actions`);
  state.failures.add("GET /api/admin/tax/expenses");
  await taxSection(page, "Overview");
  await taxSection(page, "Expenses");
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not load expenses" })
    .waitFor();
  await shot(page, report, `${device}-expenses-read-error`);
  state.failures.delete("GET /api/admin/tax/expenses");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("Total Expenses", { exact: true }).waitFor();
  state.empty = true;
  await taxSection(page, "Assets");
  await page.getByText(/No equipment/).waitFor();
  await shot(page, report, `${device}-equipment-empty`);
  state.empty = false;
  state.failures.add("GET /api/admin/banking/balance");
  await page.goto(`${server.baseUrl}/admin/banking`);
  await page.getByText(/Couldn't load balance/).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Standard Payout", exact: true })
      .last()
      .isDisabled(),
    true,
  );
  await shot(page, report, `${device}-balance-read-error`);
  state.failures.delete("GET /api/admin/banking/balance");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(
    await page
      .getByRole("button", { name: "Standard Payout", exact: true })
      .last()
      .isEnabled(),
    true,
  );
}
function gallery(report) {
  const files = report.screenshots.map((f) => path.basename(f));
  const keys = [
    ...new Set(
      files.map((f) =>
        f.replace(/^(desktop|touch-webkit)-/, "").replace(/\.png$/, ""),
      ),
    ),
  ];
  fs.writeFileSync(
    path.join(output, "review.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Banking and Taxes review</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.5 system-ui}main{max-width:1440px;margin:auto;padding:28px}h2{text-transform:capitalize}section{margin:40px 0}.pair{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,1fr);gap:20px}img{width:100%;border:1px solid #d4d4d8}figure{margin:0}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><main><h1>Banking and Taxes review</h1><p>Synthetic records · ${report.sha.slice(0, 12)} · ${report.dirty ? "working tree" : "clean commit"}</p>${keys
      .map(
        (k) =>
          `<section><h2>${k.replaceAll("-", " ")}</h2><div class="pair">${[
            "desktop",
            "touch-webkit",
          ]
            .filter((d) => files.includes(`${d}-${k}.png`))
            .map(
              (d) =>
                `<figure><figcaption>${d}</figcaption><a href="${d}-${k}.png"><img loading="lazy" src="${d}-${k}.png" alt="${k}"></a></figure>`,
            )
            .join("")}</div></section>`,
      )
      .join("")}</main></html>`,
  );
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), screenshots: [], browsers: [] };
  const server = await previewServer(root);
  try {
    for (const [device, launch, viewport, hasTouch] of [
      ["desktop", launchBrowser, { width: 1440, height: 1000 }, false],
      [
        "touch-webkit",
        () => webkit.launch({ headless: true }),
        { width: 390, height: 844 },
        true,
      ],
    ]) {
      const browser = await launch();
      const state = {
        requests: [],
        pageErrors: [],
        consoleErrors: [],
        expectedFailures: [],
        unmatched: [],
        failures: new Set(),
        geometry: [],
      };
      report.browsers.push({ device, state });
      const page = await browser.newPage({
        viewport,
        hasTouch,
        timezoneId: "America/New_York",
        serviceWorkers: "block",
      });
      try {
        page.setDefaultTimeout(15000);
        await install(page, server, state);
        await views(page, server, state, report, device);
        await workflows(page, server, state, report, device);
        assert.deepEqual(state.pageErrors, [], "Page errors");
        assert.deepEqual(state.unmatched, [], "Unmatched API");
        assert.deepEqual(
          state.consoleErrors.filter(
            (e) =>
              !(
                e.text.includes("503") &&
                (!e.url || state.expectedFailures.includes(e.url))
              ),
          ),
          [],
          "Unexpected console errors",
        );
      } catch (error) {
        report.error = error.stack;
        await shot(page, report, `${device}-failure`);
        throw error;
      } finally {
        state.hold?.release?.();
        // Drop synthetic auth before pagehide so a keepalive usage beacon cannot outlive route interception.
        await page
          .evaluate(() => localStorage.removeItem("waves_admin_token"))
          .catch(() => {});
        await browser.close();
      }
    }
  } finally {
    gallery(report);
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await server.close();
  }
  console.log("Finance UI checks passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
