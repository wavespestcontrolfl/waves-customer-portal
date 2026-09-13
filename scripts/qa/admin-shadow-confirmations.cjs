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
const output = path.join(root, ".tmp/admin-shadow-confirmations");
const fontRoots = ["roboto", "inter"].map((family) => path.dirname(require.resolve(`@fontsource/${family}/400.css`)));

const fixtureHtml = `<!doctype html>
<html class="admin-app">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/src/index.css">
  </head>
  <body>
    <main id="root" class="admin-shell-v2" style="padding:16px"></main>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const Page = (await import('/src/pages/admin/AgentShadowDraftsPage.jsx')).default;
      createRoot(document.getElementById('root')).render(React.createElement(Page));
    </script>
  </body>
</html>`;

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    requests: [],
    errors: [],
    expectedFailures: [],
    screenshots: [],
  };
  let server;
  let browser;
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [1440, 390]) {
      let profileAttempts = 0;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 768,
        serviceWorkers: "block",
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on("pageerror", (error) => report.errors.push(`${width}: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const expectedUrl = `${server.baseUrl}/api/admin/agents/voice-profiles/fixture-profile/review`;
        if (message.location().url === expectedUrl && message.text().includes("503 (Service Unavailable)")) {
          report.expectedFailures.push(width);
        } else {
          report.errors.push(`${width}: ${message.text()}`);
        }
      });
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-token");
        localStorage.setItem("waves_admin_user", JSON.stringify({
          id: "fixture-admin",
          role: "admin",
          email: "fixture@example.invalid",
        }));
      });
      await page.routeWebSocket("**/*", (socket) => socket.close());
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === "/qa-shadow-confirmations") {
          return route.fulfill({ contentType: "text/html", body: fixtureHtml });
        }
        if (url.pathname.startsWith("/@fs/")) {
          const fontFile = decodeURIComponent(url.pathname.slice(4));
          if (fontRoots.some((fontRoot) => fontFile.startsWith(`${fontRoot}/files/`)) && /\.woff2?$/.test(fontFile)) {
            return route.fulfill({ path: fontFile });
          }
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        report.requests.push({ width, method: request.method(), path: url.pathname });
        if (url.pathname === "/api/admin/agents/shadow-drafts") return json(route, { drafts: [] });
        if (url.pathname === "/api/admin/agents/shadow-scores") return json(route, { intents: [] });
        if (url.pathname === "/api/admin/agents/intent-modes") return json(route, { intents: [] });
        if (url.pathname === "/api/admin/agents/sealed-eval") return json(route, null);
        if (url.pathname === "/api/admin/agents/pathology") return json(route, null);
        if (url.pathname === "/api/admin/agents/voice-profiles" && request.method() === "GET") {
          return json(route, {
            pending: {
              id: "fixture-profile",
              version: 2,
              profile_text: "Synthetic voice guidance for confirmation layout verification.",
            },
          });
        }
        if (url.pathname === "/api/admin/agents/voice-profiles/fixture-profile/review") {
          assert.equal(request.method(), "POST");
          assert.deepEqual(request.postDataJSON(), { action: "approve" });
          profileAttempts += 1;
          return profileAttempts === 1
            ? json(route, { error: "Synthetic voice review failure." }, 503)
            : json(route, {});
        }
        return json(route, { error: "Missing synthetic fixture." }, 500);
      });

      await page.goto(`${server.baseUrl}/qa-shadow-confirmations`);
      const trigger = page.getByRole("button", { name: "Approve — make this the live voice" });
      await trigger.waitFor();
      await waitForFonts(page);
      await trigger.click();
      let dialog = page.getByRole("dialog", { name: "Approve voice profile v2?" });
      await dialog.waitFor();
      assert.equal(
        await dialog.getByText("It becomes the live voice guidance for the phone agent (and any future consumer). The previous approved version is superseded.").count(),
        1,
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const geometry = await dialog.evaluate((node) => ({
        width: node.firstElementChild.nextElementSibling.getBoundingClientRect().width,
        smallText: [...node.querySelectorAll("*")]
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => [...element.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
          .map((element) => parseFloat(getComputedStyle(element).fontSize))
          .filter((fontSize) => fontSize < 14),
        controls: [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect().height),
      }));
      assert.ok(geometry.width <= width - 32, `${width}: dialog exceeds viewport`);
      assert.deepEqual(geometry.smallText, [], `${width}: dialog has readable text below 14px`);
      if (width < 768) {
        assert.ok(geometry.controls.every((height) => height >= 43.5), `${width}: dialog control below 44px`);
      }
      const openFile = path.join(output, `approval-open-${width}.png`);
      await page.screenshot({ path: openFile, fullPage: true });
      report.screenshots.push(openFile);

      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(profileAttempts, 0, `${width}: cancel issued a write`);
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);

      await trigger.click();
      dialog = page.getByRole("dialog", { name: "Approve voice profile v2?" });
      const confirm = dialog.getByRole("button", { name: "Approve — make this the live voice" });
      await confirm.click();
      await dialog.getByRole("alert").filter({ hasText: "Synthetic voice review failure." }).waitFor();
      assert.equal(await confirm.isEnabled(), true, `${width}: failed confirmation did not recover`);
      assert.equal(await dialog.isVisible(), true, `${width}: failed confirmation closed`);
      const errorFile = path.join(output, `approval-error-${width}.png`);
      await page.screenshot({ path: errorFile, fullPage: true });
      report.screenshots.push(errorFile);
      await confirm.click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(profileAttempts, 2, `${width}: retry did not issue exactly one second write`);
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.expectedFailures, [1440, 390]);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    try {
      if (browser) await browser.close();
    } finally {
      if (server) await server.close();
    }
  }
  console.log("Admin Shadow Draft confirmations desktop/mobile fixture passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
