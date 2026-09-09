"use strict";
// SYNTHETIC UI QA. Frontend only; all APIs are fulfilled locally and external
// requests are blocked. No real records, providers, sends, or charges.
const { webkit } = require("playwright");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/design-system/customer360");
const customer = {
  id: "customer-a",
  firstName: "Avery",
  lastName: "Sample",
  email: "avery@example.invalid",
  phone: "+19415550100",
  serviceContactName: "Site contact",
  serviceContactEmail: "site@example.invalid",
  servicePausedAt: "2024-07-01T14:00:00Z",
  servicePausedOn: "2024-07-01",
  servicePauseReason: "autopay_final_failure",
  address: {
    line1: "100 Example Lane",
    city: "Example City",
    state: "FL",
    zip: "34201",
  },
  healthScore: 82,
  pipelineStage: "active_customer",
  active: true,
  tier: null,
};
const detail = {
  customer,
  notificationPrefs: {},
  preferences: { special_instructions: "Use the side gate." },
  healthScore: { overall_score: 82 },
  billingSummary: {
    complete: true,
    openBalance: 125,
    overdueBalance: 0,
    overdueCount: 0,
  },
  invoices: [],
  cards: [],
  paymentMethodConsents: [],
  contracts: [],
  photos: [],
  customerDiscounts: [],
  complianceRecords: [],
  nutrientLedger: {},
  services: [],
  payments: [],
  scheduled: [],
  upcomingScheduled: [
    {
      id: "appointment-fixture",
      service_type: "Pest Control",
      scheduled_date: "2099-09-18",
      window_start: "09:00:00",
      window_end: "10:30:00",
      status: "confirmed",
      technician_name: "Staff",
    },
  ],
  accountProperties: [],
  annualPrepayTerms: [],
};
(async () => {
  const report = [];
  const outcome = { ...evidence(root), passed: false, scenarios: report };
  fs.mkdirSync(output, { recursive: true });
  let server;
  try {
    server = await previewServer(root, process.argv[2]);
    for (const [device, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const browser =
        device === "desktop"
          ? await launchBrowser()
          : await webkit.launch({ headless: true });
      try {
        const context = await browser.newContext({
          viewport: { width, height },
          hasTouch: device === "mobile",
          timezoneId: "America/New_York",
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        const errors = [],
          writes = [],
          unmatched = [];
        page.setDefaultTimeout(15000);
        await page.addInitScript(() => {
          localStorage.setItem("waves_admin_token", "synthetic-local-token");
          localStorage.setItem(
            "waves_admin_user",
            JSON.stringify({
              id: "fixture-user",
              role: "admin",
              name: "Fixture operator",
            }),
          );
          if (navigator.serviceWorker)
            navigator.serviceWorker.register = async () => ({
              scope: "synthetic-local-test",
            });
          const originalFetch = window.fetch.bind(window);
          window.fetch = (input, options) =>
            String(input).endsWith("/admin/usage/track")
              ? Promise.resolve(
                  new Response("{}", {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  }),
                )
              : originalFetch(input, options);
        });
        page.on("pageerror", (e) => {
          errors.push(e.message);
          console.error(e.message);
        });
        await page.route("**/*", async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          if (
            url.origin !== server.baseUrl ||
            url.pathname.startsWith("/socket.io")
          )
            return route.abort();
          if (!url.pathname.startsWith("/api/")) return route.continue();
          if (req.method() !== "GET")
            writes.push({ path: url.pathname, method: req.method() });
          let body;
          if (url.pathname === "/api/admin/auth/me")
            body = {
              id: "fixture-user",
              role: "admin",
              name: "Fixture operator",
            };
          else if (url.pathname === "/api/admin/notifications/unread-count")
            body = { count: 0 };
          else if (url.pathname === "/api/admin/communications/link-library")
            body = { links: [] };
          else if (url.pathname === "/api/admin/communications/messages/read")
            body = { ok: true };
          else if (url.pathname === "/api/admin/communications/agent-draft")
            body = { draft: null };
          else if (url.pathname === "/api/admin/requests")
            body = { requests: [] };
          else if (
            [
              "/api/admin/call-recordings/commitments/open",
              "/api/admin/call-recordings/commitments/sms",
            ].includes(url.pathname)
          )
            body = { commitments: [], enabled: true, has_more: false };
          else if (url.pathname === "/api/admin/customers")
            body = {
              customers: [
                {
                  ...customer,
                  address: "100 Example Lane, Example City, FL 34201",
                },
              ],
              total: 1,
              totalPages: 1,
            };
          else if (url.pathname === "/api/admin/customers/customer-a")
            body = detail;
          else if (url.pathname.endsWith("/comms"))
            body = {
              comms: [
                {
                  id: "message-fixture",
                  channel: "sms",
                  direction: "inbound",
                  body: "Please use the side gate.",
                  createdAt: "2026-08-10T14:00:00Z",
                  conversationId: "conversation-fixture",
                },
                {
                  id: "call-fixture",
                  channel: "voice",
                  direction: "outbound",
                  body: "Synthetic call summary",
                  durationSeconds: 65,
                  createdAt: "2026-08-10T14:00:00Z",
                },
              ],
              readScope: {
                conversationIds: ["conversation-fixture"],
                through: "2026-08-10T14:01:00Z",
              },
            };
          else if (url.pathname.endsWith("/timeline"))
            body = { timeline: [], missingSources: [] };
          else if (url.pathname.endsWith("/properties"))
            body = { properties: [] };
          else if (url.pathname.endsWith("/unread-count"))
            body = { conversations: 0 };
          else if (url.pathname.endsWith("/feature-flags"))
            body = { flags: {} };
          else if (url.pathname.endsWith("/payers")) body = { payers: [] };
          else if (url.pathname.endsWith("/numbers")) body = { numbers: [] };
          if (url.pathname.endsWith("/autopay-state")) body = { recent_events: [] };
          if (url.pathname.endsWith("/credits")) body = { credits: [], balance: 0 };
          if (url.pathname === "/api/admin/document-templates") body = { templates: [] };
          if (body === undefined) {
            unmatched.push({ method: req.method(), path: url.pathname });
            body = {};
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        });
        const base = server.baseUrl + "/admin/customers";
        await page.goto(base);
        await page
          .getByRole("button", { name: "Open Avery Sample customer profile" })
          .waitFor();
        await waitForFonts(page);
        await page.screenshot({ path: `${output}/${device}-directory.png` });
        await page.getByLabel("Actions for Avery Sample").click();
        await page
          .getByRole("button", { name: "Edit customer", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "First name", exact: true })
          .waitFor();
        await page
          .getByRole("textbox", { name: "First name", exact: true })
          .fill("Draft name");
        await page
          .getByRole("button", { name: "Open Avery Sample customer profile" })
          .click();
        await page.getByRole("heading", { name: "Next appointment" }).waitFor();
        await waitForFonts(page);
        await page.screenshot({ path: `${output}/${device}-workspace.png` });
        fs.writeFileSync(
          `${output}/${device}-metrics.json`,
          JSON.stringify(
            await page.locator(".c360-workspace").evaluate((root) =>
              [
                ...root.querySelectorAll(
                  "button,a,h1,h2,h3,input,select,textarea",
                ),
              ]
                .slice(0, 70)
                .map((el) => {
                  const s = getComputedStyle(el),
                    r = el.getBoundingClientRect();
                  return {
                    tag: el.tagName,
                    text: el.textContent.trim().slice(0, 70),
                    label: el.getAttribute("aria-label"),
                    width: r.width,
                    height: r.height,
                    font: s.fontSize,
                    lineHeight: s.lineHeight,
                    transform: s.textTransform,
                  };
                }),
            ),
            null,
            2,
          ),
        );
        await page
          .getByRole("button", { name: "Message", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Text message" })
          .fill("Keep this local draft");
        await waitForFonts(page);
        await page.screenshot({ path: `${output}/${device}-message.png` });
        const drawerOverflow = await page
          .locator(".c360-message-sheet")
          .evaluate((root) =>
            [root, ...root.querySelectorAll("*")]
              .filter(
                (node) =>
                  node.clientWidth &&
                  node.scrollWidth > node.clientWidth + 2 &&
                  ["auto", "scroll"].includes(getComputedStyle(node).overflowX),
              )
              .map((node) => ({
                element: node.className,
                client: node.clientWidth,
                scroll: node.scrollWidth,
              })),
          );
        assert.deepEqual(
          drawerOverflow,
          [],
          "A long sender option must fit the mobile message drawer",
        );
        await page
          .getByRole("button", { name: "Quick Links", exact: true })
          .click();
        const links = page.getByRole("dialog", {
          name: "Quick Links",
          exact: true,
        });
        await links.waitFor();
        await page.keyboard.press("Escape");
        await links.waitFor({ state: "detached" });
        assert.equal(
          await page
            .getByRole("button", { name: "Quick Links", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.getByRole("button", { name: "Back to customer" }).click();
        assert.equal(
          await page
            .getByRole("button", { name: "Message", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page
          .getByRole("button", { name: "Message", exact: true })
          .click();
        if (
          (await page
            .getByRole("textbox", { name: "Text message" })
            .inputValue()) !== "Keep this local draft"
        )
          throw Error("Message draft lost");
        await page.getByRole("button", { name: "Back to customer" }).click();
        await page
          .getByRole("button", { name: "All customers", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "First name", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("textbox", { name: "First name", exact: true })
            .inputValue(),
          "Draft name",
          "Directory draft survives the real route transition",
        );
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.goto(base + "?customer360=overlay&customerId=customer-a");
        await page
          .locator(".c360-header-" + device)
          .getByText("Avery Sample", { exact: true })
          .waitFor();
        await waitForFonts(page);
        await page.screenshot({ path: `${output}/${device}-overlay.png` });
        await page
          .getByText("Billing paused since", { exact: false })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${output}/${device}-billing-review.png`,
        });
        await page.getByRole("button", { name: "Comms", exact: true }).click();
        await page
          .getByText("Synthetic call summary", { exact: true })
          .waitFor();
        await page
          .getByRole("combobox", { name: "Default bill-to" })
          .selectOption("__new__");
        await page.getByLabel("Payer name *").fill("Local draft payer");
        await page
          .locator(".c360-recipient-overrides")
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${output}/${device}-recipients-review.png`,
        });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.keyboard.press("Escape");
        await page.locator(".c360-panel").waitFor({ state: "detached" });
        report.push({
          device,
          errors,
          writes,
          unmatched,
          overflow: await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        });
        console.log(`Customer360 interactions complete: ${device}`);
      } finally {
        await browser.close();
      }
    }
    assert.ok(
      report.every((item) => item.errors.length === 0 && !item.overflow),
    );
    assert.deepEqual(
      report.flatMap((item) => item.unmatched),
      [],
    );
    assert.ok(
      report
        .flatMap((item) => item.writes)
        .every(
          (write) =>
            write.path === "/api/admin/communications/messages/read" &&
            write.method === "POST",
        ),
      "Only synthetic read acknowledgments are expected",
    );
    outcome.passed = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    outcome.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    try { await server?.close(); }
    catch (error) {
      outcome.passed = false;
      outcome.cleanupFailure = { name: error.name, message: error.message };
      throw error;
    } finally {
      fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(outcome, null, 2));
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
