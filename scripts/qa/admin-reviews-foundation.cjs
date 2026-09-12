"use strict";
/* global document, localStorage, innerWidth, getComputedStyle */
// Synthetic frontend-only QA. API responses are fulfilled in-process and all
// external requests and sockets are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  previewServer,
  launchBrowser,
  evidence,
  waitForFonts,
} = require("./browser");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-reviews-foundation");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2 p-4"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/ReviewsPage.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(Page));
</script></body></html>`;

const location = {
  id: "sarasota",
  name: "Sarasota",
  rating: 4.9,
  totalReviews: 84,
  pendingUpdates: 1,
  hasCredentials: true,
  reviewUrl: "https://example.invalid/review",
  reviewsSource: "gbp",
  gbp: {
    business_name: "Waves Pest Control",
    primary_category: "Pest control service",
  },
};
const customer = {
  id: "customer-17",
  name: "Taylor Example",
  firstName: "Taylor",
  phone: "+19415550117",
  city: "Sarasota",
  locationId: "sarasota",
  lastService: "General Pest Control",
  lastServiceDate: "2026-09-10T12:00:00.000Z",
  lifetimeRevenue: 840,
  askCount: 0,
  sendable: true,
  cadenceable: true,
  eligibilityReasons: [],
};
const review = {
  id: "review-7",
  reviewerName: "Taylor Example",
  starRating: 5,
  reviewText: "Clear communication and thoughtful service.",
  createTime: "2026-09-10T13:00:00.000Z",
  locationId: "sarasota",
  locationName: "Sarasota",
  reply: null,
  autoReply: { status: "parked", reason: "low_rating" },
};

function visibleTypography() {
  const visible = (node) =>
    node.getClientRects().length > 0 && !node.closest("[hidden], [inert]");
  return [...document.querySelectorAll("*")]
    .filter(visible)
    .filter((node) =>
      [...node.childNodes].some(
        (child) => child.nodeType === 3 && child.textContent.trim(),
      ),
    )
    .filter((node) => parseFloat(getComputedStyle(node).fontSize) < 14)
    .map((node) => ({
      text: node.textContent.trim().slice(0, 60),
      font: getComputedStyle(node).fontSize,
    }));
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    scenarios: [],
    screenshots: [],
    requests: [],
    unmatched: [],
    pageErrors: [],
  };
  const server = await previewServer(root, process.env.ADMIN_UI_PREVIEW_URL);
  const browser = await launchBrowser();
  try {
    for (const width of [390, 768, 1024, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: width <= 768 ? 900 : 1000 },
        hasTouch: width <= 768,
        serviceWorkers: "block",
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      await page.addInitScript(() =>
        localStorage.setItem("waves_admin_token", "synthetic-token"),
      );
      await page.routeWebSocket("**/*", (socket) => socket.close());
      page.on("pageerror", (error) =>
        report.pageErrors.push(`${width}: ${error.message}`),
      );
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === "/qa-reviews")
          return route.fulfill({ contentType: "text/html", body: html });
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const entry = {
          width,
          method: request.method(),
          path: url.pathname,
          search: url.search,
          body: request.postData() ? request.postDataJSON() : undefined,
        };
        report.requests.push(entry);
        let body;
        if (url.pathname === "/api/admin/reviews")
          body = {
            reviews: [review],
            locations: [location],
            hasMore: false,
            stats: {
              totalReviews: 84,
              avgRating: 4.9,
              unresponded: 1,
              responded: 83,
              newThisMonth: 4,
              locationBreakdown: {
                sarasota: { 5: 80, 4: 4, 3: 0, 2: 0, 1: 0 },
              },
              perLocation: [
                { locationId: "sarasota", count: 84, avgRating: "4.9" },
              ],
            },
          };
        else if (url.pathname === "/api/admin/reviews/outreach-candidates")
          body = { customers: [customer], reviewSequencesEnabled: true };
        else if (url.pathname === "/api/admin/reviews/outreach-analytics")
          body = {
            funnel: {
              sent: 8,
              opened: 7,
              rated: 6,
              reviewed: 5,
              conversionRate: 63,
            },
            googleByLocation: [{ locationId: "sarasota", reviews: 5 }],
            byLocation: [],
            byChannel: [],
            byTemplate: [],
            velocity: [{ week: "2026-09-07", reviews: 5 }],
            activeSequences: 1,
          };
        else if (url.pathname === "/api/admin/reviews/outreach-activity")
          body = { items: [] };
        else if (
          url.pathname === "/api/admin/reviews/send-request" &&
          request.method() === "POST"
        )
          body = { success: true };
        else if (url.pathname === "/api/admin/reviews/incentives")
          body = {
            summary: {},
            policy: { enabled: true },
            payouts: url.searchParams.get("days") === "7" ? [{
              id: "payout-synthetic",
              technicianName: "Synthetic Technician",
              customerName: "Taylor Example",
              status: "earned",
              amountCents: 500,
              source: "google_review",
              earnedAt: "2026-09-10T12:00:00.000Z",
            }] : [],
            period: {},
          };
        else if (
          url.pathname === "/api/admin/reviews/incentives/attribution-queue"
        )
          body = { items: [] };
        else if (url.pathname === "/api/admin/gbp/locations")
          body = { locations: [location] };
        else if (url.pathname === "/api/admin/gbp/updates")
          body = { updates: [] };
        else if (url.pathname === "/api/admin/gbp/notifications")
          body = { preferences: { enabled: true, frequency: "realtime" } };
        if (body === undefined) {
          report.unmatched.push(
            `${request.method()} ${url.pathname}${url.search}`,
          );
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: "Unmatched synthetic request" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.goto(`${server.baseUrl}/qa-reviews`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page
        .getByText("Clear communication and thoughtful service.")
        .waitFor();
      await waitForFonts(page);
      const capture = async (name) => {
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `horizontal overflow in ${name} at ${width}`,
        );
        assert.deepEqual(
          await page.evaluate(visibleTypography),
          [],
          `small text in ${name} at ${width}`,
        );
        const controls = await page
          .locator("button,input,select,textarea")
          .evaluateAll((nodes) =>
            nodes
              .filter(
                (node) =>
                  node.getClientRects().length &&
                  node.getAttribute("type") !== "checkbox",
              )
              .map((node) => ({
                height: node.getBoundingClientRect().height,
                font: parseFloat(getComputedStyle(node).fontSize),
              })),
          );
        assert.ok(
          controls.every(
            (control) =>
              control.font >= 14 && control.height >= (width <= 768 ? 44 : 32),
          ),
          `undersized control in ${name} at ${width}: ${JSON.stringify(controls)}`,
        );
        const shot = `${name}-${width}.png`;
        await page.screenshot({
          path: path.join(output, shot),
          fullPage: true,
          animations: "disabled",
        });
        report.screenshots.push(shot);
        report.scenarios.push({ width, name });
      };
      await capture("reviews");
      const pipelineBadge = page.getByText("Needs you (low rating)", { exact: true });
      await pipelineBadge.waitFor();
      assert.notEqual(await pipelineBadge.evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");

      await page.getByRole("button", { name: "Outreach", exact: true }).click();
      await page.getByText("Review Routing", { exact: true }).waitFor();
      await capture("outreach-dashboard");
      await page
        .getByRole("button", { name: /Pipeline/ })
        .last()
        .click();
      await page.getByText("Taylor Example", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const sheet = page.getByRole("dialog", {
        name: "Review outreach for Taylor Example",
      });
      await sheet.waitFor();
      await sheet.getByRole("combobox").selectOption("resolution_check");
      await sheet
        .getByPlaceholder("Compose review request...")
        .fill("Hi Taylor, checking that everything is resolved.");
      await Promise.all([
        page.waitForResponse((res) =>
          res.url().endsWith("/admin/reviews/send-request"),
        ),
        sheet
          .getByRole("button", { name: "Send Check-In", exact: true })
          .click(),
      ]);
      const write = report.requests
        .filter(
          (request) =>
            request.width === width && request.path.endsWith("/send-request"),
        )
        .at(-1);
      assert.deepEqual(write.body, {
        customerId: "customer-17",
        serviceType: "General Pest Control",
        techName: null,
        templateId: "resolution_check",
        body: "Hi Taylor, checking that everything is resolved.",
      });
      await capture("outreach-sheet");
      await sheet
        .getByRole("button", { name: "Close outreach details" })
        .click();

      await page
        .getByRole("button", { name: "Incentives", exact: true })
        .click();
      await page
        .getByText("No eligible post-launch Google reviews yet.")
        .waitFor();
      await capture("incentives");
      await Promise.all([
        page.waitForResponse((res) => res.url().endsWith("/incentives?days=7")),
        page.getByRole("combobox").selectOption("7"),
      ]);
      await page.getByText("Synthetic Technician", { exact: true }).waitFor();
      await capture("incentives-ledger");
      await page.getByRole("button", { name: "GBP", exact: true }).click();
      await page.getByText("Waves Pest Control", { exact: true }).waitFor();
      await capture("gbp");
      const rating = page.getByRole("button", { name: /Sarasota/ }).getByText("4.9", { exact: true });
      assert.ok(await rating.evaluate((node) => getComputedStyle(node).color !== getComputedStyle(node.closest("button")).backgroundColor), "selected location rating must contrast with its button");
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      await page.getByLabel("Business Name", { exact: true }).fill("Waves Pest Control");
      await capture("gbp-profile");
      await page.getByRole("button", { name: /^Updates/ }).first().click();
      await page.getByRole("button", { name: "Bulk Edit", exact: true }).click();
      await page.getByLabel("Field to Edit", { exact: true }).selectOption("phone");
      await page.getByLabel("New Value", { exact: true }).fill("9415550117");
      await capture("gbp-bulk");
      await page.getByRole("button", { name: "Alerts", exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector("select")?.value === "realtime");
      await page.getByLabel("Frequency", { exact: true }).selectOption("weekly");
      await capture("gbp-alerts");
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser.close();
    await server.close();
  }
  console.log(
    "Reviews desktop/mobile workspaces and outreach payload checks passed.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
