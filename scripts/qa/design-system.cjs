"use strict";
// SYNTHETIC UI QA. Frontend only. Every API request is fulfilled locally;
// external requests and sockets are blocked. Never uses real customer records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/design-system/browser");

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    sizes: [],
    scenarios: [],
    screenshots: [],
    unmatched: [],
    pageErrors: [],
    consoleErrors: [],
  };
  const server = await previewServer(root, process.argv[2]);
  let browser, safari;
  async function openPage(engine, viewport, coarse) {
    const context = await engine.newContext({
      viewport,
      hasTouch: coarse,
      timezoneId: "America/New_York",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
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
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin !== server.baseUrl ||
        url.pathname.startsWith("/socket.io")
      )
        return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let body;
      if (url.pathname === "/api/admin/auth/me")
        body = { id: "fixture-user", role: "admin", name: "Fixture operator" };
      else if (url.pathname === "/api/admin/feature-flags")
        body = { flags: {} };
      else if (
        [
          "/api/admin/notifications/unread-count",
          "/api/admin/communications/unread-count",
        ].includes(url.pathname)
      )
        body = { count: 0, conversations: 0 };
      else if (url.pathname === "/api/admin/usage/track") body = { ok: true };
      else {
        report.unmatched.push(url.pathname);
        body = { error: "Unmatched synthetic fixture" };
      }
      return route.fulfill({
        status: body.error ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.goto(`${server.baseUrl}/admin/_design-system`);
    await page
      .getByRole("heading", { name: "Design system", exact: true })
      .waitFor();
    await waitForFonts(page);
    return { context, page };
  }
  async function screenshot(page, name, locator) {
    if (locator) await locator.scrollIntoViewIfNeeded();
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push(path.relative(root, file));
  }
  async function sizes(page, width, height, coarse, orientation) {
    await page.setViewportSize({ width, height });
    const actualCoarse = await page.evaluate(
      () => matchMedia("(any-pointer: coarse)").matches,
    );
    assert.equal(
      actualCoarse,
      coarse,
      "Pointer emulation must match the reported case",
    );
    for (const density of ["comfortable", "compact", "touch"]) {
      await page
        .getByRole("combobox", { name: "Density", exact: true })
        .selectOption(density);
      const metrics = await Promise.all(
        [
          page.getByRole("button", { name: "Save", exact: true }).first(),
          page.getByRole("textbox", { name: "Customer search", exact: true }),
          page.getByRole("combobox", { name: "Example option", exact: true }),
        ].map((control) =>
          control.evaluate((node) => {
            const rect = node.getBoundingClientRect(),
              style = getComputedStyle(node);
            return {
              tag: node.tagName,
              height: rect.height,
              width: rect.width,
              font: parseFloat(style.fontSize),
              textTransform: style.textTransform,
            };
          }),
        ),
      );
      const expected =
        density === "touch"
          ? 48
          : density === "compact" && width >= 1024 && !coarse
            ? 36
            : 44;
      const entry = {
        width,
        height,
        coarse,
        orientation,
        density,
        expected,
        metrics,
      };
      report.sizes.push(entry);
      for (const metric of metrics)
        assert.equal(metric.height, expected, JSON.stringify(entry));
      assert.equal(metrics[0].font, 14);
      assert.equal(metrics[1].font, 16);
      assert.equal(metrics[2].font, 16);
      assert.equal(metrics[0].textTransform, "none");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `Page overflow: ${JSON.stringify(entry)}`,
      );
    }
  }
  async function interactions(page, name) {
    await page
      .getByRole("combobox", { name: "Density", exact: true })
      .selectOption("comfortable");
    const email = page.getByRole("textbox", { name: "Contact email" });
    assert.equal(await email.getAttribute("aria-invalid"), "true");
    const resolvedDescriptions = await email.evaluate((node) =>
      node
        .getAttribute("aria-describedby")
        .split(" ")
        .every((id) => document.getElementById(id)),
    );
    assert.equal(resolvedDescriptions, true);
    await email.fill("operator@example.invalid");
    assert.equal(await email.getAttribute("aria-invalid"), null);

    const note = page.getByRole("textbox", {
      name: "Service note",
      exact: true,
    });
    await note.fill("Preserve this failed-save draft.");
    const save = page.getByRole("button", { name: "Save note", exact: true });
    await save.scrollIntoViewIfNeeded();
    const before = await save.boundingBox();
    await page
      .getByRole("form", { name: "Save behavior example" })
      .evaluate((form) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    assert.equal(await save.isDisabled(), true);
    assert.equal(await save.getAttribute("aria-busy"), "true");
    const during = await save.boundingBox();
    assert.equal(
      during.width,
      before.width,
      "Loading text and reserved spinner must not resize the action",
    );
    assert.equal(during.height, before.height);
    await page
      .getByText("Example save failed. Your note is still here.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await note.inputValue(), "Preserve this failed-save draft.");
    assert.equal(
      await page.getByText("Save attempts: 1", { exact: true }).count(),
      1,
    );
    await page
      .getByRole("checkbox", { name: "Simulate a save failure" })
      .uncheck();
    await save.click();
    await page.getByText("Example saved.", { exact: true }).waitFor();

    const state = page.getByRole("combobox", { name: "Result state" });
    await state.selectOption("partial");
    // Mobile cells include their visible field caption in the accessible name.
    assert.equal(
      await page.getByRole("cell", { name: /Not recorded$/ }).count(),
      1,
    );
    assert.equal(await page.getByRole("cell", { name: /\$0\.00$/ }).count(), 1);
    await state.selectOption("empty");
    await page
      .getByText(
        "No records match these filters. Clear the filters to try again.",
        { exact: true },
      )
      .waitFor();
    await state.selectOption("error");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    assert.equal(await state.inputValue(), "ready");
    await screenshot(
      page,
      `${name}-directory-pattern`,
      page.locator("#data-states"),
    );

    const draftSection = page.locator("#draft-ownership");
    await page
      .getByRole("textbox", { name: "Draft title" })
      .fill("Retain this title");
    await page
      .getByRole("textbox", { name: "Draft notes" })
      .fill("Retain these notes");
    await draftSection
      .getByRole("tab", { name: "Activity", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Draft title").inputValue(),
      "Retain this title",
    );
    assert.equal(await page.getByLabel("Draft title").isVisible(), false);
    assert.equal(
      await draftSection.getByRole("tabpanel").count(),
      1,
      "Hidden panels stay out of the accessibility flow",
    );
    await draftSection
      .getByRole("tab", { name: "Activity", exact: true })
      .press("Home");
    assert.equal(
      await page.getByRole("textbox", { name: "Draft title" }).inputValue(),
      "Retain this title",
    );
    assert.equal(
      await page.getByRole("textbox", { name: "Draft notes" }).inputValue(),
      "Retain these notes",
    );
    await draftSection
      .getByRole("tab", { name: "Draft", exact: true })
      .press("End");
    await page
      .getByRole("textbox", { name: "Internal billing note" })
      .fill("Restricted draft");
    await page
      .getByRole("combobox", { name: "Example role" })
      .selectOption("tech");
    assert.equal(
      await draftSection
        .getByRole("tab", { name: "Billing", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByLabel("Internal billing note").count(), 0);
    assert.equal(
      await page.getByRole("textbox", { name: "Draft title" }).inputValue(),
      "",
    );
    await page
      .getByRole("textbox", { name: "Draft title" })
      .fill("Customer A only");
    await page
      .getByRole("combobox", { name: "Example customer" })
      .selectOption("b");
    assert.equal(
      await page.getByRole("textbox", { name: "Draft title" }).inputValue(),
      "",
    );
    await screenshot(page, `${name}-draft-pattern`, draftSection);

    const opener = page.getByRole("button", {
      name: "Open example message drawer",
    });
    await opener.click();
    const sheet = page.getByRole("dialog", {
      name: "Example message drawer",
      exact: true,
    });
    await page
      .getByRole("textbox", { name: "Example message" })
      .fill("Keep the drawer draft.");
    const review = page.getByRole("button", { name: "Review example draft" });
    await review.click();
    const dialog = page.getByRole("dialog", {
      name: "Review draft",
      exact: true,
    });
    await dialog.waitFor();
    assert.equal(
      await dialog.evaluate((node) =>
        node
          .getAttribute("aria-labelledby")
          .split(" ")
          .every((id) => document.getElementById(id)),
      ),
      true,
    );
    await screenshot(page, `${name}-nested-overlays`);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await sheet.isVisible(), true);
    assert.equal(
      await review.evaluate((node) => node === document.activeElement),
      true,
    );
    await page.getByRole("button", { name: "Close drawer" }).click();
    await sheet.waitFor({ state: "detached" });
    assert.equal(
      await opener.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(
      await page.getByText("Ancestor clicks: 0", { exact: true }).count(),
      1,
    );
    // A desktop backdrop closes its own sheet and never clicks its ancestor.
    if (page.viewportSize().width > 700) {
      await opener.click();
      await sheet
        .locator(":scope > div")
        .first()
        .click({ position: { x: 5, y: 5 } });
      await sheet.waitFor({ state: "detached" });
      assert.equal(
        await page.getByText("Ancestor clicks: 0", { exact: true }).count(),
        1,
      );
    }
    report.scenarios.push({ name, passed: true });
  }
  try {
    browser = await launchBrowser();
    for (const coarse of [false, true]) {
      for (const width of [390, 700, 820, 1024, 1440]) {
        const { context, page } = await openPage(
          browser,
          { width, height: Math.max(844, width + 100) },
          coarse,
        );
        await sizes(
          page,
          width,
          Math.max(844, width + 100),
          coarse,
          "portrait",
        );
        await sizes(
          page,
          width,
          Math.min(800, Math.floor(width * 0.65)),
          coarse,
          "landscape",
        );
        await context.close();
      }
      console.log(`Geometry complete: ${coarse ? "coarse" : "fine"} pointer`);
    }
    const desktop = await openPage(
      browser,
      { width: 1440, height: 1000 },
      false,
    );
    await screenshot(desktop.page, "desktop-catalog");
    await interactions(desktop.page, "desktop");
    await desktop.context.close();
    safari = await webkit.launch({ headless: true });
    const mobile = await openPage(safari, { width: 390, height: 844 }, true);
    await screenshot(mobile.page, "mobile-catalog");
    await interactions(mobile.page, "mobile");
    // Viewport contraction is an emulated keyboard condition, not a claim of
    // a physical iOS keyboard/notch test. The focused field must remain usable.
    await sizes(mobile.page, 390, 360, true, "keyboard-contracted");
    await mobile.page
      .getByRole("button", { name: "Open example message drawer" })
      .click();
    const message = mobile.page.getByRole("textbox", {
      name: "Example message",
    });
    await message.fill("Editing with a contracted viewport.");
    await message.scrollIntoViewIfNeeded();
    assert.equal(
      await message.evaluate((node) => node === document.activeElement),
      true,
    );
    const fieldBox = await message.boundingBox();
    assert.ok(
      fieldBox.y >= 0 && fieldBox.y + fieldBox.height <= 360,
      "Focused drawer field fits the contracted viewport",
    );
    const review = mobile.page.getByRole("button", {
      name: "Review example draft",
    });
    await review.scrollIntoViewIfNeeded();
    assert.equal(
      (await review.boundingBox()).height,
      48,
      "Touch density survives the portal/global touch rules",
    );
    await screenshot(mobile.page, "mobile-keyboard-drawer");
    await review.click();
    await mobile.page.getByRole("button", { name: "Keep editing" }).click();
    assert.equal(
      await message.inputValue(),
      "Editing with a contracted viewport.",
    );
    report.scenarios.push({
      name: "WebKit contracted keyboard viewport",
      passed: true,
    });
    await mobile.context.close();
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    report.passed = true;
    console.log(
      JSON.stringify({
        sizes: report.sizes.length,
        scenarios: report.scenarios,
        screenshots: report.screenshots.length,
      }),
    );
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => browser?.close()),
      Promise.resolve().then(() => safari?.close()),
      Promise.resolve().then(() => server.close()),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) {
      report.passed = false;
      report.cleanupFailures = failures.map((error) => String(error?.message || error));
    }
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (failures.length) throw new AggregateError(failures, "Browser QA cleanup failed");
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
