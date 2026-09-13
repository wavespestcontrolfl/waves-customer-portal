"use strict";
/* global window, navigator, localStorage, innerWidth */
// Actual admin route; every API request is synthetic. No vendor email or scan runs.
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
const output = path.join(root, ".tmp/admin-price-match-foundation");

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    scenarios: [],
    unmatched: [],
    errors: [],
  };
  const server = await previewServer(root);
  const browser = await launchBrowser();
  try {
    for (const width of [390, 820, 1440]) {
      const writes = [];
      let failList = false,
        failSend = false,
        empty = false;
      let draft = {
        id: "qa-draft",
        status: "pending",
        subject: "QA price match request",
        recipient: "rep@example.invalid",
        included_count: 1,
        created_at: new Date().toISOString(),
        html: "<p>Synthetic email preview</p>",
        matches: [
          {
            product: "Fixture product",
            competitor: {
              vendor: "Fixture vendor",
              source_url: "https://example.invalid/proof",
            },
          },
        ],
      };
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width < 1440,
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      await page.routeWebSocket("**/*", (socket) => socket.close());
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.addInitScript(() => {
        if (window !== window.top) return;
        // Block registration at the page boundary; Playwright's global blocker
        // probes navigator.serviceWorker inside the deliberately opaque preview.
        navigator.serviceWorker.register = async () => undefined;
        localStorage.setItem("waves_admin_token", "synthetic-token");
        localStorage.setItem(
          "waves_admin_user",
          JSON.stringify({
            id: "qa-admin",
            name: "Fixture operator",
            role: "admin",
          }),
        );
      });
      await page.route("**/*", async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          key = `${req.method()} ${url.pathname}`;
        if (
          url.origin !== server.baseUrl ||
          url.pathname.startsWith("/socket.io")
        )
          return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        let body,
          status = 200;
        if (key === "GET /api/admin/auth/me")
          body = { id: "qa-admin", name: "Fixture operator", role: "admin" };
        else if (key === "GET /api/admin/feature-flags") body = { flags: {} };
        else if (url.pathname.endsWith("/unread-count"))
          body = { count: 0, conversations: 0 };
        else if (key === "POST /api/admin/usage/track") body = { ok: true };
        else if (key === "GET /api/admin/price-match/drafts") {
          body = failList
            ? { error: "Synthetic list failure" }
            : {
                drafts: empty ? [] : [draft],
                recipient: "rep@example.invalid",
              };
          status = failList ? 503 : 200;
        } else if (key === "GET /api/admin/price-match/drafts/qa-draft")
          body = { draft };
        else if (key === "POST /api/admin/price-match/scan") {
          writes.push({ key, body: req.postDataJSON() });
          body = {
            evaluated: 1,
            products: ["Fixture product"],
            vendors: ["Fixture vendor"],
          };
        } else if (
          req.method() === "POST" &&
          url.pathname.startsWith("/api/admin/price-match/drafts/qa-draft/")
        ) {
          writes.push({ key, body: req.postData() });
          const action = url.pathname.split("/").at(-1);
          if (action === "send" && failSend) {
            status = 400;
            body = {
              error: "Synthetic send configuration failure",
              code: "not_configured",
            };
          } else {
            draft = {
              ...draft,
              status:
                action === "send"
                  ? "sent"
                  : action === "dismiss"
                    ? "dismissed"
                    : "pending",
            };
            body = { ok: true };
          }
        } else {
          report.unmatched.push(key);
          status = 404;
          body = { error: "Unmatched synthetic fixture" };
        }
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${server.baseUrl}/admin/price-match`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByRole("button", { name: /QA price match request/ })
        .click();
      await page
        .getByRole("button", { name: "Send to rep…", exact: true })
        .waitFor();
      await waitForFonts(page);
      const geometry = await page.getByLabel("Draft review").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: innerWidth };
      });
      assert.ok(
        geometry.left >= 0 && geometry.right <= width + 1,
        JSON.stringify(geometry),
      );
      assert.equal(
        await page
          .locator('iframe[title="Price-match email preview"]')
          .getAttribute("sandbox"),
        "",
      );
      assert.equal(
        await page
          .getByRole("link", { name: "View listing" })
          .getAttribute("href"),
        "https://example.invalid/proof",
      );
      await page.screenshot({
        path: path.join(output, `review-${width}.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Send to rep…", exact: true })
        .click();
      assert.equal(writes.length, 0);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(writes.length, 0);
      failSend = true;
      await page
        .getByRole("button", { name: "Send to rep…", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Confirm send", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic send configuration failure" })
        .waitFor();
      failSend = false;
      await page
        .getByRole("button", { name: "Send to rep…", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Confirm send", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Price-match request sent" })
        .waitFor();
      assert.deepEqual(
        writes.map((w) => w.key),
        [
          "POST /api/admin/price-match/drafts/qa-draft/send",
          "POST /api/admin/price-match/drafts/qa-draft/send",
        ],
      );
      assert.ok(writes.every((w) => w.body === null));
      await page.getByRole("button", { name: "Dismiss notice" }).click();
      draft = {
        ...draft,
        status: "sending",
        claimed_at: new Date().toISOString(),
        send_attempted_at: new Date().toISOString(),
      };
      await page.getByRole("button", { name: "All", exact: true }).click();
      await page
        .getByRole("button", { name: /QA price match request/ })
        .click();
      await page.getByText(/A send was attempted/).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Dismiss", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Reset", exact: true }).count(),
        0,
      );
      draft = {
        ...draft,
        claimed_at: new Date(Date.now() - 11 * 60000).toISOString(),
        send_attempted_at: null,
      };
      await page.getByRole("button", { name: "Active", exact: true }).click();
      await page
        .getByRole("button", { name: /QA price match request/ })
        .click();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Draft reset to pending" })
        .waitFor();
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Draft dismissed." })
        .waitFor();
      await page
        .getByRole("button", { name: "Preview scan", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Selection preview: 1 product" })
        .waitFor();
      assert.deepEqual(writes.at(-1), {
        key: "POST /api/admin/price-match/scan",
        body: { mode: "select" },
      });
      failList = true;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic list failure" })
        .waitFor();
      failList = false;
      empty = true;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByText("No drafts in this view.").waitFor();
      const small = await page
        .locator("main .ui-surface")
        .evaluate((root) =>
          [...root.querySelectorAll("button")]
            .filter(
              (e) =>
                e.getClientRects().length &&
                e.getBoundingClientRect().height < 43,
            )
            .map((e) => e.textContent),
        );
      assert.deepEqual(small, []);
      await page.screenshot({
        path: path.join(output, `empty-${width}.png`),
        fullPage: true,
      });
      report.scenarios.push({
        width,
        geometry,
        sendConfirmation: true,
        failedSendRecovery: true,
        staleClaimGuard: true,
        resetDismiss: true,
        scanPayload: true,
        readRecovery: true,
      });
      await context.setOffline(true);
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    try {
      await browser.close();
    } finally {
      await server.close();
    }
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      scenarios: report.scenarios.length,
      output,
    }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
