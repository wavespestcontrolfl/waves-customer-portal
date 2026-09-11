"use strict";
/* global localStorage, document, getComputedStyle, innerWidth, innerHeight */
// Actual recruiting route with synthetic API fixtures; no applicant contact occurs.
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
const output = path.join(root, ".tmp/admin-recruiting-foundation");
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    scenarios: [],
    unmatched: [],
    errors: [],
  };
  // Both resources are acquired inside the cleanup scope so a browser-launch
  // failure still closes the Vite child instead of keeping the process alive.
  let server, browser;
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [390, 820, 1440]) {
      let failStatus = false,
        failRead = false;
      const writes = [];
      let applicant = {
        id: "qa-applicant",
        role: "technician",
        status: "new",
        created_at: new Date().toISOString(),
        contact_snapshot: {
          name: "Fixture Applicant",
          phone: "+19415550199",
          email: "fixture@example.invalid",
          city: "Fixture City",
        },
        ai_score: 78,
        ai_recommendation: "strong",
        ai_summary: "Synthetic applicant summary",
        ai_screen: {
          summary: "Synthetic applicant summary",
          strengths: ["Outdoor experience"],
          flags: ["Discuss availability"],
        },
        answers: { availability: "Next month", why_waves: "Synthetic answer" },
      };
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width < 1440,
        timezoneId: "America/New_York",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.routeWebSocket("**/*", (s) => s.close());
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-token");
        localStorage.setItem(
          "waves_admin_user",
          JSON.stringify({
            id: "qa-admin",
            role: "admin",
            name: "Fixture operator",
          }),
        );
      });
      await page.route("**/*", async (route) => {
        const req = route.request(),
          u = new URL(req.url()),
          key = `${req.method()} ${u.pathname}`;
        let status = 200,
          body;
        if (u.origin !== server.baseUrl || u.pathname.startsWith("/socket.io"))
          return route.abort();
        if (!u.pathname.startsWith("/api/")) return route.continue();
        if (key === "GET /api/admin/auth/me")
          body = { id: "qa-admin", role: "admin", name: "Fixture operator" };
        else if (key === "GET /api/admin/feature-flags") body = { flags: {} };
        else if (u.pathname.endsWith("/unread-count"))
          body = { count: 0, conversations: 0 };
        else if (key === "POST /api/admin/usage/track") body = { ok: true };
        else if (key === "GET /api/admin/careers") {
          status = failRead ? 503 : 200;
          body = failRead
            ? { error: "Synthetic read failure" }
            : {
                applications:
                  u.searchParams.get("status") === applicant.status
                    ? [applicant]
                    : [],
                counts: { [applicant.status]: 1 },
              };
        } else if (key === "GET /api/admin/careers/qa-applicant")
          body = { application: applicant };
        else if (key === "PATCH /api/admin/careers/qa-applicant/status") {
          const payload = req.postDataJSON();
          writes.push(payload);
          status = failStatus ? 503 : 200;
          if (!failStatus) applicant = { ...applicant, status: payload.status };
          body = failStatus
            ? { error: "Synthetic status failure" }
            : { application: applicant };
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
      await page.goto(
        `${server.baseUrl}/admin/recruiting?application=qa-applicant&keep=yes`,
        { waitUntil: "domcontentloaded" },
      );
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await waitForFonts(page);
      assert.ok(page.url().includes("keep=yes"));
      assert.ok(!page.url().includes("application="));
      assert.equal(
        await dialog
          .getByRole("link", { name: "Text", exact: true })
          .getAttribute("href"),
        "sms:+19415550199",
      );
      const note = dialog.getByPlaceholder(
        "Optional note for this status change…",
      );
      await note.fill("Fixture review note");
      failStatus = true;
      await dialog
        .getByRole("button", { name: "Reviewed", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic status failure" })
        .waitFor();
      assert.equal(await note.inputValue(), "Fixture review note");
      failStatus = false;
      await dialog
        .getByRole("button", { name: "Reviewed", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector("textarea")?.value === "",
      );
      assert.deepEqual(writes, [
        { status: "reviewed", note: "Fixture review note" },
        { status: "reviewed", note: "Fixture review note" },
      ]);
      // The role="dialog" element is the fixed inset-0 overlay, so its box is
      // always the viewport. Measure the panel (its focusable child) instead.
      const geometry = await dialog
        .locator(':scope > [tabindex="-1"]')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            overflowX: el.scrollWidth - el.clientWidth,
            width: innerWidth,
            height: innerHeight,
          };
        });
      assert.ok(
        geometry.left >= 0 &&
          geometry.right <= width + 1 &&
          geometry.top >= 0 &&
          geometry.bottom <= geometry.height + 1 &&
          geometry.overflowX <= 1,
        JSON.stringify(geometry),
      );
      assert.equal(
        await note.evaluate((el) => getComputedStyle(el).fontSize),
        "16px",
      );
      await page.screenshot({
        path: path.join(output, `dialog-${width}.png`),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("tab", { name: /^Reviewed/ }).click();
      const row = page.getByRole("button", { name: /Fixture Applicant/ });
      await row.waitFor();
      await row.click();
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        document.activeElement?.textContent?.includes("Fixture Applicant"),
      );
      await page.screenshot({
        path: path.join(output, `list-${width}.png`),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      failRead = true;
      await page.getByRole("tab", { name: "Interview", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic read failure" })
        .waitFor();
      failRead = false;
      await page.getByRole("tab", { name: "Offer", exact: true }).click();
      await page.getByText("No offer applications.", { exact: true }).waitFor();
      report.scenarios.push({
        width,
        deepLink: true,
        statusPayload: true,
        noteRecovery: true,
        mobileDialog: true,
        emptyAndError: true,
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
      if (browser) await browser.close();
    } finally {
      if (server) await server.close();
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
