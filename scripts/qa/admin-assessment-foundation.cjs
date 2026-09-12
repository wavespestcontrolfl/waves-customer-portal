"use strict";
/* global localStorage, document, innerWidth, getComputedStyle */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  previewServer,
  launchBrowser,
  waitForFonts,
  evidence,
} = require("./browser");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-assessment-foundation");
const previewUrl =
  process.argv.find((argument) => argument.startsWith("http://")) ||
  process.env.ADMIN_UI_PREVIEW_URL;

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    previewUrl,
    pageErrors: [],
    consoleErrors: [],
    requests: [],
    geometry: [],
    screenshots: [],
  };
  let server;
  let browser;
  try {
    server = await previewServer(root, previewUrl);
    browser = await launchBrowser();
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 1440,
        serviceWorkers: "block",
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on("pageerror", (error) =>
        report.pageErrors.push(`${width}: ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          report.consoleErrors.push(`${width}: ${message.text()}`);
      });
      await page.routeWebSocket("**/*", (socket) => socket.close());
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-token");
        localStorage.setItem(
          "waves_admin_user",
          JSON.stringify({
            id: "fixture-admin",
            name: "Fixture admin",
            email: "fixture@example.invalid",
            role: "admin",
          }),
        );
        localStorage.setItem("lawn_guide_seen", "1");
      });
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.origin !== server.baseUrl ||
          url.pathname.startsWith("/socket.io")
        )
          return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        report.requests.push({
          width,
          method: request.method(),
          path: url.pathname,
          search: url.search,
        });
        let body = {};
        if (url.pathname === "/api/admin/auth/me") {
          body = {
            id: "fixture-admin",
            name: "Fixture admin",
            email: "fixture@example.invalid",
            role: "admin",
          };
        } else if (url.pathname === "/api/admin/feature-flags") {
          body = { flags: {} };
        } else if (url.pathname === "/api/admin/notifications/unread-count") {
          body = { count: 0 };
        } else if (url.pathname === "/api/admin/communications/unread-count") {
          body = { conversations: 0, messages: 0 };
        } else if (url.pathname === "/api/admin/lawn-assessment/customers") {
          body = {
            customers: [
              {
                id: "customer-1",
                serviceId: "service-1",
                firstName: "Synthetic",
                lastName: "Customer",
                address: "123 Main Street, Sarasota",
                phone: "941-555-0100",
                serviceType: "Lawn care",
                windowStart: "9:00 AM",
                lastAssessment: "2026-08-20",
              },
            ],
          };
        } else if (
          url.pathname === "/api/admin/customers/customer-1/turf-profile"
        ) {
          body = {
            irrigation_home_changed_at: "2026-09-01T12:00:00Z",
            profile: {
              grass_type: "st_augustine",
              track_key: "st_augustine",
              cultivar: "Floratam",
              sun_exposure: "full_sun",
              lawn_sqft: 4200,
              irrigation_type: "in_ground",
              irrigation_inches_per_week: 1,
              municipality: "Sarasota",
              county: "Sarasota",
              soil_test_date: "2026-04-10",
              soil_ph: 6.5,
              known_chinch_history: true,
              known_disease_history: false,
              known_drought_stress: true,
              annual_n_budget_target: 4,
              active: true,
            },
          };
        } else if (url.pathname === "/api/admin/lawn-assessment/assess") {
          assert.equal(request.method(), "POST");
          assert.deepEqual(request.postDataJSON(), {
            customerId: "customer-1",
            serviceId: "service-1",
            photos: [
              {
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
                mimeType: "image/png",
              },
            ],
          });
          body = {
            assessment: { id: "assessment-1" },
            adjustedScores: {
              turf_density: 80,
              weed_suppression: 70,
              color_health: 60,
              fungus_control: 50,
              thatch_level: 40,
            },
            divergenceFlags: [
              { metric: "color_health", claude: 75, gemini: 45 },
            ],
            observations:
              "Synthetic lawn observations for layout verification.",
            season: "wet",
            isBaseline: true,
          };
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.goto(`${server.baseUrl}/admin/lawn-assessments?tab=field`);
      await page.waitForFunction(() =>
        document.body.innerText.includes("Synthetic Customer"),
      );
      const pageText = await page.locator("body").innerText();
      assert.ok(
        pageText.includes("Synthetic Customer"),
        `${width}: synthetic customer missing from rendered page: ${pageText.slice(0, 1000)}`,
      );
      const customerMatches = page.getByText("Synthetic Customer", {
        exact: false,
      });
      let customer = null;
      for (let index = 0; index < (await customerMatches.count()); index += 1) {
        const match = customerMatches.nth(index);
        if (await match.isVisible()) {
          customer = match;
          break;
        }
      }
      if (!customer) {
        console.error(
          `${width}: customer candidates`,
          await customerMatches.evaluateAll((nodes) =>
            nodes.map((node) => ({
              tag: node.tagName,
              text: node.textContent,
              rect: node.getBoundingClientRect().toJSON(),
              display: getComputedStyle(node).display,
              visibility: getComputedStyle(node).visibility,
            })),
          ),
        );
        console.error(`${width}: body`, pageText.slice(0, 2000));
        await page.screenshot({
          path: path.join(output, `failure-${width}.png`),
          fullPage: true,
        });
      }
      assert.ok(customer, `${width}: visible customer row missing`);
      await waitForFonts(page);

      async function capture(name, anchor = customer) {
        const panel = page
          .locator('[data-ui-density="comfortable"]')
          .filter({ has: anchor })
          .last();
        const metrics = await panel.evaluate((node) => {
          const visible = (element) => element.getClientRects().length > 0;
          const controls = [
            ...node.querySelectorAll(
              'button,input:not([type="file"]):not([type="checkbox"]),select,textarea',
            ),
          ]
            .filter(visible)
            .map((element) => ({
              name:
                element.getAttribute("aria-label") ||
                element.textContent.trim(),
              height: element.getBoundingClientRect().height,
              font: parseFloat(getComputedStyle(element).fontSize),
            }));
          const smallText = [...node.querySelectorAll("*")]
            .filter(visible)
            .filter((element) =>
              [...element.childNodes].some(
                (child) => child.nodeType === 3 && child.textContent.trim(),
              ),
            )
            .map((element) => ({
              text: element.textContent.trim().slice(0, 70),
              font: parseFloat(getComputedStyle(element).fontSize),
            }))
            .filter(({ font }) => font < 14);
          return {
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            controls,
            smallText,
          };
        });
        assert.equal(metrics.overflow, false, `${name}: horizontal overflow`);
        assert.deepEqual(
          metrics.smallText,
          [],
          `${name}: readable text below 14px`,
        );
        for (const control of metrics.controls) {
          assert.ok(
            control.height >= 43.5,
            `${name}: control below 44px ${JSON.stringify(control)}`,
          );
          assert.ok(
            control.font >= 14,
            `${name}: control text below 14px ${JSON.stringify(control)}`,
          );
        }
        const filename = `${name}.png`;
        await page.screenshot({
          path: path.join(output, filename),
          fullPage: true,
        });
        report.geometry.push({
          name,
          width,
          controls: metrics.controls.length,
        });
        report.screenshots.push(filename);
      }

      await capture(`select-${width}`);
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      const profileHeading = page.getByRole("heading", {
        name: /Turf Profile/,
      });
      await profileHeading.waitFor();
      await capture(`profile-${width}`, profileHeading);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByLabel("Search today's lawn customers").waitFor();
      await page
        .getByText("Synthetic Customer", { exact: false })
        .last()
        .click();
      await page
        .getByRole("button", { name: "Add Photo", exact: true })
        .waitFor();
      await page.locator('input[type="file"]').setInputFiles({
        name: "synthetic-lawn.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"),
      });
      await page
        .getByRole("button", { name: "Analyze 1 Photo with AI", exact: true })
        .click();
      const scoreHeading = page.getByRole("heading", { name: /AI Scorecard/ });
      await scoreHeading.waitFor();
      await capture(`scorecard-${width}`, scoreHeading);
      const scoreGeometry = await page
        .locator('[data-ui-density="comfortable"]')
        .filter({ has: scoreHeading })
        .last()
        .evaluate((node) => {
          const buttons = [
            ...node.querySelectorAll('button[aria-label^="Decrease "]'),
          ];
          const tiles = buttons.map((button) => {
            const tile = button.parentElement.parentElement.parentElement;
            const increase = tile.querySelector(
              'button[aria-label^="Increase "]',
            );
            const tileRect = tile.getBoundingClientRect();
            const decreaseRect = button.getBoundingClientRect();
            const increaseRect = increase.getBoundingClientRect();
            return {
              label: button.getAttribute("aria-label").replace("Decrease ", ""),
              tile: {
                left: tileRect.left,
                right: tileRect.right,
                top: tileRect.top,
                bottom: tileRect.bottom,
              },
              decrease: {
                left: decreaseRect.left,
                right: decreaseRect.right,
                width: decreaseRect.width,
                height: decreaseRect.height,
              },
              increase: {
                left: increaseRect.left,
                right: increaseRect.right,
                width: increaseRect.width,
                height: increaseRect.height,
              },
            };
          });
          return tiles;
        });
      assert.equal(
        scoreGeometry.length,
        5,
        `${width}: expected five score tiles`,
      );
      for (const score of scoreGeometry) {
        assert.ok(
          score.decrease.width >= 43.5 && score.decrease.height >= 43.5,
          `${width}: decrease target ${score.label}`,
        );
        assert.ok(
          score.increase.width >= 43.5 && score.increase.height >= 43.5,
          `${width}: increase target ${score.label}`,
        );
        assert.ok(
          score.decrease.left >= score.tile.left &&
            score.increase.right <= score.tile.right,
          `${width}: score controls escape ${score.label}`,
        );
        assert.ok(
          score.decrease.right <= score.increase.left,
          `${width}: score controls overlap ${score.label}`,
        );
      }
      for (let left = 0; left < scoreGeometry.length; left += 1) {
        for (let right = left + 1; right < scoreGeometry.length; right += 1) {
          const a = scoreGeometry[left].tile;
          const b = scoreGeometry[right].tile;
          const overlap =
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top;
          assert.equal(overlap, false, `${width}: score tiles overlap`);
        }
      }
      report.geometry.push({
        name: `score-tiles-${width}`,
        width,
        scores: scoreGeometry,
      });
      await context.close();
    }

    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    report.passed = true;
    report.finishedAt = new Date().toISOString();
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    if (browser) await browser.close();
    if (server) await server.close();
  }
  console.log(
    `Assessment browser evidence passed: ${path.join(output, "report.json")}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
