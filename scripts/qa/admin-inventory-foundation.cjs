"use strict";
// Frontend-only proof. Every API is fulfilled with synthetic data and all
// external traffic and sockets are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const {
  previewServer,
  launchBrowser,
  evidence,
  waitForFonts,
} = require("./browser");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-inventory-foundation");
const product = {
  id: "product-1",
  name: "Synthetic barrier treatment",
  category: "General pest",
  activeIngredient: "Example ingredient",
  moaGroup: "3A",
  formulation: "Suspension concentrate",
  containerSize: "1 gal",
  defaultUnit: "oz",
  inventoryOnHand: 12,
  inventoryUnit: "fl_oz",
  lowStockThreshold: 2,
  lowStock: false,
  bestPrice: 45,
  unitPrices: [{ unit: "fl_oz", pricePerUnit: 1.40625 }],
  costPerUnit: 1.40625,
  costUnit: "fl_oz",
  bestVendor: "Fixture Supply",
  needsPricing: false,
  vendorPricing: [],
  customerVisibility: "portal_only",
  contentStatus: "draft",
  commonName: "Fixture barrier",
  publicSummary: "A synthetic product summary for interface verification.",
  portalSummary: "Synthetic service-history copy.",
  customerSafetySummary: "Follow the label.",
  petKidGuidanceText: "Keep people and pets away until dry.",
  targetPests: ["ants"],
  applicationZones: ["exterior perimeter"],
};
const vendor = {
  id: "vendor-1",
  name: "Fixture Supply",
  type: "distributor",
  active: true,
  website: "https://example.invalid",
  productCount: 1,
  bestPriceCount: 1,
  scrapingEnabled: true,
  hasCredentials: false,
  lastScrapeStatus: "completed",
  connections: [],
  verifiedMappings: 1,
  currentPrices: 1,
};

function responseFor(url) {
  const pathname = url.pathname;
  if (pathname === "/api/admin/auth/me")
    return { id: "fixture-admin", role: "admin", name: "Fixture admin" };
  if (pathname === "/api/admin/feature-flags") return { flags: {} };
  if (
    [
      "/api/admin/notifications/unread-count",
      "/api/admin/communications/unread-count",
    ].includes(pathname)
  )
    return { count: 0, conversations: 0 };
  if (pathname === "/api/admin/usage/track") return { ok: true };
  if (pathname === "/api/admin/inventory/stats")
    return {
      products: { total: 1, priced: 1, needsPrice: 0, lowStock: 0 },
      vendors: { total: 1 },
      approvals: { pending: 1 },
      restockRequests: { open: 0 },
      scrapeJobs: { completed: 1 },
    };
  if (pathname === "/api/admin/inventory/label-pipeline")
    return { enabled: true };
  if (pathname === "/api/admin/inventory/vendors") return { vendors: [vendor] };
  if (pathname === "/api/admin/inventory/price-sync/vendors")
    return { vendors: [vendor] };
  if (pathname === "/api/admin/inventory/price-sync/needs-mapping")
    return { products: [] };
  if (pathname === "/api/admin/inventory/price-sync/review-queue")
    return { approvals: [] };
  if (pathname === "/api/admin/inventory/lawn-outline-facts")
    return {
      facts: [],
      summary: {
        total: 0,
        approved: 0,
        ready_to_approve: 0,
        needs_facts: 0,
        missing_product: 0,
        missingFields: {},
      },
    };
  if (pathname === "/api/admin/service-outlines/content-modules")
    return { modules: [] };
  if (pathname === "/api/admin/inventory/waveguard-forecast")
    return {
      forecast: {
        days: 14,
        serviceCount: 0,
        productCount: 0,
        statusCounts: {},
        products: [],
        errors: [],
      },
    };
  if (pathname === "/api/admin/inventory/unit-review")
    return { products: [{ ...product, inventoryUnit: "unknown", suggestedUnit: "fl_oz", reasons: [{ code: "unsupported", message: "Choose a supported unit" }] }], forecastRows: [], counts: {} };
  if (pathname === "/api/admin/inventory/restock-requests")
    return { requests: [] };
  if (pathname === "/api/admin/inventory/approvals")
    return {
      approvals: [
        {
          id: "approval-1",
          product_name: product.name,
          vendor_name: vendor.name,
          category: product.category,
          old_price: 40,
          new_price: 45,
          price_change_pct: 12.5,
          notes: "Synthetic review",
        },
      ],
    };
  if (pathname === "/api/admin/inventory/service-usage")
    return {
      services: [
        {
          serviceType: "General Pest Control",
          totalCost: 4.22,
          products: [
            {
              id: "usage-1",
              productId: product.id,
              productName: product.name,
              usageAmount: 3,
              usageUnit: "oz",
              usagePer1000sf: null,
              bestPrice: 45,
              costPerApp: 4.22,
              costSource: "vendor_price",
              costWarning: null,
              isPrimary: true,
              notes: "Exterior perimeter",
            },
          ],
        },
      ],
    };
  if (pathname === "/api/admin/inventory/protocol-health")
    return {
      lines: [
        {
          serviceLine: "general_pest",
          status: "ready",
          templateCount: 1,
          cogsRows: 1,
          missingCostRows: 0,
          warnings: [],
        },
      ],
    };
  if (pathname === "/api/admin/inventory/scrape-jobs")
    return {
      jobs: [
        {
          id: "job-1",
          vendor_name: vendor.name,
          status: "completed",
          products_found: 1,
          prices_updated: 1,
          prices_new: 0,
          errors: 0,
          duration_ms: 900,
          created_at: "2026-09-11T12:00:00.000Z",
        },
      ],
    };
  if (pathname === `/api/admin/inventory/${product.id}/label-review`)
    return { review: { draft: { id: "candidate-1", source: { productName: product.name, registration: "TEST-100", url: "https://example.invalid/label.pdf" }, facts: Object.fromEntries(["minTempF", "maxTempF", "maxWindMph", "rainFreeHours"].map(key => [key, { status: "not_stated" }])) } } };
  if (pathname === `/api/admin/inventory/${product.id}/movements`)
    return { movements: [] };
  if (pathname === "/api/admin/inventory")
    return {
      products: [product],
      categories: [{ name: product.category, count: 1 }],
      total: 1,
    };
  return null;
}

async function metricsFor(page, surface) {
  return surface.evaluate((node) => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    controls: [...node.querySelectorAll("button,input,select,textarea")]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({
        height: element.getBoundingClientRect().height,
        font: parseFloat(getComputedStyle(element).fontSize),
      })),
    readable: [...node.querySelectorAll("p,span,td,th,h1,h2,h3,label")]
      .filter(
        (element) =>
          element.getClientRects().length && element.textContent.trim(),
      )
      .map((element) => parseFloat(getComputedStyle(element).fontSize)),
  }));
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    requests: [],
    sizes: [],
    leaves: [],
    unmatched: [],
    pageErrors: [],
  };
  let server;
  let chrome;
  let safari;
  try {
    server = await previewServer(root, "http://127.0.0.1:25157");
    chrome = await launchBrowser();
    safari = await webkit.launch();
    for (const [name, browser, hasTouch] of [
      ["desktop", chrome, false],
      ["mobile", safari, true],
    ]) {
      const context = await browser.newContext({
        viewport: { width: hasTouch ? 390 : 1440, height: 900 },
        hasTouch,
        serviceWorkers: "block",
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-local-token");
        localStorage.setItem(
          "waves_admin_user",
          JSON.stringify({
            id: "fixture-admin",
            role: "admin",
            name: "Fixture admin",
          }),
        );
      });
      page.on("pageerror", (error) =>
        report.pageErrors.push(`${name}: ${error.message}`),
      );
      await page.routeWebSocket("**/*", (socket) => socket.close());
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.origin !== server.baseUrl ||
          url.pathname.startsWith("/socket.io")
        )
          return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const record = {
          viewport: name,
          method: request.method(),
          path: url.pathname,
          search: url.search,
        };
        if (request.postData()) record.body = request.postDataJSON();
        if (
          url.pathname === "/api/admin/inventory" &&
          request.method() === "POST"
        ) {
          assert.deepEqual(record.body, {
            name: "Synthetic new product",
            category: "Fixture category",
            activeIngredient: "",
            moaGroup: "",
            defaultUnit: "oz",
            inventoryOnHand: "",
            inventoryUnit: "",
            lowStockThreshold: "",
          });
          report.requests.push(record);
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ product: { id: "new-product" } }),
          });
        }
        if (url.pathname === "/api/admin/inventory/unit-review/product-1/fix" && request.method() === "POST") {
          report.requests.push(record);
          return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        }
        if (url.pathname === "/api/admin/inventory/product-1/label-review/decision" && request.method() === "POST") {
          assert.deepEqual(record.body, { candidateId: "candidate-1", decision: "approve", identityConfirmed: true });
          report.requests.push(record);
          return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        }
        const body = responseFor(url);
        if (body == null) {
          report.unmatched.push(
            `${request.method()} ${url.pathname}${url.search}`,
          );
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: "{}",
          });
        }
        if (url.pathname === "/api/admin/inventory")
          report.requests.push(record);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.goto(`${server.baseUrl}/admin/inventory?source=synthetic`);
      await page.getByText(product.name, { exact: true }).first().waitFor();
      report.leaves.push({ name, leaf: "Products" });
      await waitForFonts(page);
      const surface = page
        .locator('[data-ui-density="comfortable"]')
        .filter({ has: page.getByRole("heading", { name: "Inventory" }) })
        .first();
      assert.equal(await surface.count(), 1);
      for (const width of [390, 700, 820, 1024, 1440]) {
        for (const height of [900, 500]) {
          await page.setViewportSize({ width, height });
          const metrics = await metricsFor(page, surface);
          assert.equal(
            metrics.overflow,
            false,
            `${name} overflow at ${width}x${height}`,
          );
          for (const control of metrics.controls) {
            assert.ok(
              control.height >= 44,
              `${name} control ${control.height}px at ${width}x${height}`,
            );
            assert.ok(
              control.font >= 14,
              `${name} control font ${control.font}px at ${width}x${height}`,
            );
          }
          for (const font of metrics.readable)
            assert.ok(
              font >= 14,
              `${name} readable font ${font}px at ${width}x${height}`,
            );
          report.sizes.push({
            name,
            width,
            height,
            controls: metrics.controls.length,
            readable: metrics.readable.length,
          });
        }
      }

      await page.setViewportSize({ width: hasTouch ? 390 : 1440, height: 900 });
      await page.reload();
      await page.getByText(product.name, { exact: true }).first().waitFor();
      await page.getByText(product.name, { exact: true }).first().click();
      await page.getByText("Manual Adjustment", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, `${name}-product-detail.png`),
        fullPage: true,
      });

      const labelReview = page.getByRole("region", { name: "Label weather review" });
      await labelReview.getByRole("button", { name: "Approve weather facts" }).waitFor();
      await labelReview.scrollIntoViewIfNeeded();
      assert.ok((await labelReview.boundingBox()).width <= (hasTouch ? 390 : 1440) - 64 + 1, "Label review remains within its viewport cap inside the expanded table row");
      await page.screenshot({ path: path.join(output, `${name}-label-review.png`), fullPage: true });
      assert.equal(await labelReview.getByRole("button", { name: "Approve weather facts" }).isDisabled(), true);
      await labelReview.getByRole("checkbox").check();
      await labelReview.getByRole("button", { name: "Approve weather facts" }).click();
      await labelReview.getByText("Review saved. Reopen the Job Card to use the current evidence.", { exact: true }).waitFor();
      assert.equal(await labelReview.getByRole("checkbox").isChecked(), false);

      if (!hasTouch) {
        await page.getByRole("button", { name: "Add Product" }).click();
        await page.getByLabel("Product name").fill("Synthetic new product");
        await page
          .getByLabel("Category", { exact: true })
          .fill("Fixture category");
        await page
          .getByRole("button", { name: "Save", exact: true })
          .first()
          .click();
        await page.getByText("Product added", { exact: true }).waitFor();
      }

      const navigation = [
        [
          "Vendors & Pricing",
          ["Price Sync", "Approvals", "Vendors", "Scrape Health"],
        ],
        ["Planning", ["Forecast", "Unit Review", "Restock"]],
        ["Content", ["Registry", "Lawn Facts", "Lawn Content"]],
        ["Protocols", ["Protocols", "Service Margins"]],
      ];
      for (const [group, leaves] of navigation) {
        await page
          .getByRole("button", {
            name: new RegExp(`^${group}(?: \\(\\d+\\))?$`),
          })
          .first()
          .click();
        for (const leaf of leaves) {
          await page
            .getByRole("button", {
              name: new RegExp(`^${leaf}(?: \\(\\d+\\))?$`),
            })
            .first()
            .click();
          await page.waitForTimeout(75);
          if (leaf === "Price Sync" || leaf === "Registry") {
            const initial = leaf === "Price Sync" ? "Vendor Sync Status" : "All Products";
            const next = leaf === "Price Sync" ? "Needs Mapping" : "Public";
            const initialButton = page.getByRole("button", { name: initial, exact: true });
            const nextButton = page.getByRole("button", { name: next, exact: true });
            await initialButton.waitFor();
            assert.equal(await initialButton.getAttribute("aria-pressed"), "true");
            await nextButton.click();
            assert.equal(await nextButton.getAttribute("aria-pressed"), "true");
            assert.equal(await initialButton.getAttribute("aria-pressed"), "false");
          }
          if (leaf === "Unit Review") {
            await page.getByRole("button", { name: "fl_oz · suggested", exact: true }).waitFor();
            await page.getByText("Apply unit: fl_oz", { exact: true }).waitFor();
            const fixPath = "/api/admin/inventory/unit-review/product-1/fix";
            await Promise.all([page.waitForResponse(response => response.url().includes(fixPath)), page.getByRole("button", { name: "Apply", exact: true }).click()]);
            assert.deepEqual(report.requests.filter(request => request.path === fixPath).at(-1).body, { inventoryUnit: "fl_oz", convertExistingStock: true });
            await page.getByLabel(`Custom unit for ${product.name}`).fill("gal");
            await page.getByText("Apply unit: gal", { exact: true }).waitFor();
            await page.getByRole("checkbox", { name: "Convert existing stock and low-stock threshold" }).uncheck();
            await Promise.all([page.waitForResponse(response => response.url().includes(fixPath)), page.getByRole("button", { name: "Apply", exact: true }).click()]);
            assert.deepEqual(report.requests.filter(request => request.path === fixPath).at(-1).body, { inventoryUnit: "gal", convertExistingStock: false });
            await page.screenshot({ path: path.join(output, `${name}-unit-review.png`), fullPage: true });
          }
          assert.equal(await surface.count(), 1);
          report.leaves.push({ name, leaf });
        }
        await page.screenshot({
          path: path.join(
            output,
            `${name}-${group.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.png`,
          ),
          fullPage: true,
        });
      }
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    assert.ok(
      report.requests.some(
        (request) =>
          request.method === "POST" && request.path === "/api/admin/inventory",
      ),
    );
    assert.ok(
      report.requests.some(
        (request) =>
          request.method === "GET" &&
          request.path === "/api/admin/inventory" &&
          request.search.includes("limit=50"),
      ),
    );
    assert.equal(report.leaves.length, 26);
    report.passed = true;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await safari?.close();
    await chrome?.close();
    await server?.close();
  }
  console.log(
    `Admin inventory foundation proof passed: ${report.sizes.length} viewport cases and ${report.leaves.length} leaf states. Evidence: ${output}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
