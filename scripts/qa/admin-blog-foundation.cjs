"use strict";
/* global document, localStorage, innerWidth, getComputedStyle, window */
// Synthetic frontend-only QA. Every API response is fulfilled in-process;
// sockets and external requests are blocked.
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
const output = path.join(root, ".tmp/admin-blog-foundation");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2 p-4"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/BlogPage.jsx')).default;
const source = await (await fetch('/src/pages/admin/BlogPage.jsx')).text();
const routerPath = source.match(/from "([^"]*react-router-dom[^"]*)"/)[1];
const { BrowserRouter } = await import(routerPath);
createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter, null, React.createElement(Page)));
</script></body></html>`;

const post = {
  id: "post-17",
  title: "Synthetic termite guide for Sarasota homes",
  content:
    "Synthetic article content for the local browser proof. It stays isolated from all real records.",
  meta_description:
    "Synthetic description used to verify the complete blog editor and its existing save contract in a local mocked browser.",
  keyword: "synthetic termite evidence",
  tag: "Termites",
  city: "Sarasota",
  status: "draft",
  author_slug: "author-1",
  reviewer_slug: "",
  technically_reviewed_at: null,
  fact_checked_at: null,
  category: "termite",
  post_type: "diagnostic",
  service_areas_tag: ["Sarasota"],
  related_services: [],
  target_sites: ["wavespestcontrol.com"],
  hero_image_alt: "Synthetic termite evidence",
  featured_image_url: null,
  word_count: 14,
  seo_score: 72,
  astro_status: "draft",
  publish_date: "2026-09-10",
};

function bodyFor(url, method) {
  if (url.pathname === "/api/admin/content/blog/analytics")
    return { byStatus: { published: 4, draft: 1, queued: 2, idea: 3 } };
  if (url.pathname === "/api/admin/content/blog")
    return { posts: [post], counts: {} };
  if (url.pathname === "/api/admin/content/weather")
    return {
      weather: {
        temp: 88,
        humidity: 70,
        rainfall: 1.2,
        soilTemp: 81,
        station: "Synthetic station",
      },
      signals: ["Termite pressure is elevated in the synthetic fixture."],
    };
  if (url.pathname === "/api/admin/content/authors")
    return {
      authors: [
        { slug: "author-1", name: "Synthetic author", fdacs_license: null },
        {
          slug: "reviewer-1",
          name: "Synthetic reviewer",
          fdacs_license: "TEST-1",
        },
      ],
    };
  if (url.pathname === "/api/public/service-areas")
    return {
      serviceAreas: [
        { slug: "sarasota", city: "Sarasota" },
        { slug: "bradenton", city: "Bradenton" },
      ],
    };
  if (url.pathname === "/api/admin/content/blog/audit")
    return {
      audit: {
        total: 10,
        published: 4,
        drafts: 1,
        queued: 2,
        ideas: 3,
        recommendations: [
          {
            priority: "critical",
            title: "Synthetic content gap",
            action: "Review the synthetic fixture before publishing.",
          },
        ],
        topicDistribution: {
          counts: { Termites: 4, Mosquitoes: 6 },
          gaps: ["Synthetic rodent guide"],
        },
        cityDistribution: {
          counts: { Sarasota: 6, Bradenton: 4 },
          overrepresented: [{ city: "Sarasota" }],
        },
        duplicates: [],
        topPerformers: [{ score: 91, title: "Synthetic top performer" }],
      },
    };
  if (
    url.pathname === "/api/admin/content/blog/post-17" &&
    method === "PUT"
  )
    return { post };
  if (
    url.pathname === "/api/admin/content/generate" &&
    method === "POST"
  )
    return { id: "generated-post" };
  if (url.pathname === "/api/admin/usage/track") return { ok: true };
  return null;
}

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
    for (const width of [390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 900 : 1000 },
        hasTouch: width === 390,
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
        if (url.pathname === "/qa-blog")
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
        const body = bodyFor(url, request.method());
        if (body === null) {
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

      const capture = async (name) => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await waitForFonts(page);
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
              .filter((node) => node.getClientRects().length)
              .map((node) => ({
                text: node.textContent.trim().slice(0, 40),
                height: node.getBoundingClientRect().height,
                font: parseFloat(getComputedStyle(node).fontSize),
              })),
          );
        assert.ok(
          controls.every(
            (control) =>
              control.font >= 14 &&
              control.height >= (width === 390 ? 44 : 28),
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

      await page.goto(`${server.baseUrl}/qa-blog?tab=posts&status=draft`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const postRow = page.getByRole("button", { name: new RegExp(post.title) });
      await postRow.waitFor();
      await capture("posts");

      await postRow.click();
      const titleInput = page.getByRole("textbox", { name: "Title" });
      await titleInput.waitFor();
      await capture("editor");
      await titleInput.fill("Edited synthetic guide");
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/api/admin/content/blog/post-17"),
        ),
        page.getByRole("button", { name: "Save draft" }).click(),
      ]);

      const blogNav = page.getByRole("navigation", { name: "Blog section" });
      await blogNav.getByRole("button", { name: "Generate" }).click();
      await page.getByText("FAWN weather", { exact: true }).waitFor();
      await page
        .getByPlaceholder("Describe the topic or paste a working title...")
        .fill("Synthetic refresh topic");
      await page.getByRole("button", { name: /Page Refresh/ }).click();
      await page
        .getByRole("button", { name: "Sarasota", exact: true })
        .click();
      await capture("generate");
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/api/admin/content/generate"),
        ),
        page.getByRole("button", { name: "Generate Page Refresh" }).click(),
      ]);

      await blogNav.getByRole("button", { name: "Audit" }).click();
      await page.getByText("Synthetic content gap", { exact: true }).waitFor();
      await capture("audit");
      await context.close();
    }

    for (const width of [390, 1440]) {
      const save = report.requests.find(
        (request) =>
          request.width === width &&
          request.method === "PUT" &&
          request.path === "/api/admin/content/blog/post-17",
      );
      assert.ok(save, `missing save request at ${width}`);
      assert.equal(save.body.title, "Edited synthetic guide");
      assert.deepEqual(save.body.target_sites, ["wavespestcontrol.com"]);
      const generate = report.requests.find(
        (request) =>
          request.width === width &&
          request.method === "POST" &&
          request.path === "/api/admin/content/generate",
      );
      assert.deepEqual(generate.body, {
        topic: "Synthetic refresh topic",
        contentType: "page_refresh",
        targetCity: "Sarasota",
      });
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(
      path.join(output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
