"use strict";
/* global document, localStorage, innerWidth, getComputedStyle */
// Synthetic frontend-only QA. Every API response is fulfilled in-process;
// external HTTP requests and sockets are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { previewServer, launchBrowser, evidence, waitForFonts } = require("./browser");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-social-foundation");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2 p-4"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/SocialMediaPage.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(Page));
</script></body></html>`;

function visibleTypography() {
  const visible = (node) => node.getClientRects().length > 0 && !node.closest("[hidden], [inert]");
  return [...document.querySelectorAll("*")]
    .filter(visible)
    .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
    .filter((node) => parseFloat(getComputedStyle(node).fontSize) < 14)
    .map((node) => ({ text: node.textContent.trim().slice(0, 60), font: getComputedStyle(node).fontSize }));
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, scenarios: [], screenshots: [], requests: [], unmatched: [], pageErrors: [] };
  const server = await previewServer(root, process.env.ADMIN_UI_PREVIEW_URL);
  let browser = null;
  try {
    browser = await launchBrowser();
    for (const width of [390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 900 : 1000 },
        hasTouch: width === 390,
        serviceWorkers: "block",
        timezoneId: "America/New_York",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      await page.addInitScript(() => localStorage.setItem("waves_admin_token", "synthetic-token"));
      await page.routeWebSocket("**/*", (socket) => socket.close());
      page.on("pageerror", (error) => report.pageErrors.push(`${width}: ${error.message}`));
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === "/qa-social") return route.fulfill({ contentType: "text/html", body: html });
        if (url.pathname === "/fixture-social.svg") {
          return route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#f4f4f5"/><path d="M70 150h160M150 70v160" stroke="#a1a1aa" stroke-width="8"/></svg>',
          });
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const entry = {
          width,
          method: request.method(),
          path: url.pathname,
          search: url.search,
          body: request.postData() ? request.postDataJSON() : undefined,
        };
        report.requests.push(entry);
        const requestPath = `${url.pathname}${url.search}`;
        let body;
        if (requestPath === "/api/admin/social-media/status") {
          body = {
            automation: { enabled: true, paused: false, dryRun: false, rssAutopublish: true, scheduledPosts: true, newsletterAutoshare: true },
            platforms: {
              facebook: { enabled: true, configured: true },
              instagram: { enabled: true, configured: true },
              gbp: { enabled: true, configured: true },
            },
          };
        } else if (requestPath === "/api/admin/social-media/stats") body = { total: 8, published: 7, failed: 1, last7d: 3 };
        else if (requestPath === "/api/admin/social-media/history?limit=20") body = { posts: [{ id: "post-1", title: "Synthetic social post", status: "published", created_at: "2026-09-11T14:00:00Z", platforms_posted: [{ platform: "facebook", success: true }] }] };
        else if (requestPath === "/api/admin/social-media/health") body = { checkedAt: "2026-09-11T14:00:00Z", credentials: [{ platform: "facebook", status: "healthy", details: { pageName: "Waves", linkedInstagramUsername: "waves" } }, { platform: "instagram", status: "healthy", details: { username: "waves", quotaUsage: 2 } }] };
        else if (requestPath === "/api/admin/social-media/alerts") body = { active: false };
        else if (requestPath === "/api/admin/social-media/autonomous/status") body = { enabled: true, globalAutomationEnabled: true, channels: ["gbp", "facebook"] };
        else if (requestPath === "/api/admin/social-media/campaign-builder/preview" && request.method() === "POST") body = { drafts: { facebook: "Synthetic Facebook draft", gbp: "Synthetic GBP draft" }, validation: { facebook: { valid: true }, gbp: { valid: true } }, suggestedLink: "https://example.invalid/termite", sources: [{ type: "service", label: "Termite", detail: "Synthetic source fact" }] };
        else if (requestPath === "/api/admin/social-media/campaign-builder/save" && request.method() === "POST") body = { success: true };
        else if (requestPath === "/api/admin/social-media/rss") body = { items: [{ title: "Synthetic feed item", description: "A safe fixture.", link: "https://example.invalid/feed", pubDate: "2026-09-11T14:00:00Z", posted: true }] };
        else if (requestPath === "/api/admin/social-media/autonomous/runs?limit=30") body = { runs: [{ id: "run-1", status: "draft_created", topic: "Termite season", startedAt: "2026-09-11T14:00:00Z", channels: ["facebook"], preview: { drafts: { facebook: "Approve this draft" }, visual: { variants: [{ imageUrl: `${server.baseUrl}/fixture-social.svg` }] } } }] };
        else if (requestPath === "/api/admin/social-media/autonomous/runs/run-1/approve" && request.method() === "POST") body = { published: true };
        else if (requestPath === "/api/admin/social-media/review-graphics?limit=30") body = { candidates: [{ googleReviewId: "review-1", reviewerDisplayName: "Taylor Example", city: "Sarasota", excerpt: "Clear communication and thoughtful service." }], saved: [] };
        else if (requestPath === "/api/admin/social-media/competitor-swipe") body = { profiles: [{ id: "profile-1", company_name: "Synthetic Competitor", city: "Sarasota", state: "FL", growth_pct: 12, strategic_notes: ["Uses useful local education."] }], posts: [], patterns: [{ key: "pattern-1", label: "Local hook", copyablePattern: "Lead with a local observation." }] };
        else if (requestPath === "/api/admin/social-media/analytics") body = { summary: { totalPosts: 8, published: 7, successRate: 88, postsPerWeek: 3, mostActivePlatform: "facebook" }, byPlatform: { facebook: { success: 5, failed: 1, total: 6 } }, weeklyTrend: [{ week: "2026-09-07", total: 3, published: 3 }], topPosts: [{ id: "post-1", title: "Synthetic social post", publishedAt: "2026-09-11T14:00:00Z", engagement: { likes: 4, comments: 2, shares: 1, score: 7 } }] };
        else if (url.pathname === "/api/admin/content/calendar") body = { items: [] };
        else if (requestPath === "/api/admin/content/blog?status=draft&limit=100&sort=updated_at&order=desc") body = { posts: [] };
        if (body === undefined) {
          report.unmatched.push(`${request.method()} ${requestPath}`);
          return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unmatched synthetic request" }) });
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });

      await page.goto(`${server.baseUrl}/qa-social`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.getByText("Local Campaign", { exact: true }).waitFor();
      await waitForFonts(page);
      const capture = async (name) => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow in ${name} at ${width}`);
        assert.deepEqual(await page.evaluate(visibleTypography), [], `small text in ${name} at ${width}`);
        const shot = `${name}-${width}.png`;
        await page.screenshot({ path: path.join(output, shot), fullPage: true, animations: "disabled" });
        report.screenshots.push(shot);
        report.scenarios.push({ width, name });
      };
      await capture("campaigns");

      await page.getByPlaceholder("termite swarm season").fill("rodent pressure");
      await page.getByRole("button", { name: "Generate Drafts" }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("textarea")].some(
          (node) => node.value === "Synthetic Facebook draft",
        ),
      );
      await page.getByRole("button", { name: "Save Draft" }).click();
      const previewWrite = report.requests.filter((item) => item.width === width && item.path.endsWith("/campaign-builder/preview")).at(-1);
      assert.equal(previewWrite.method, "POST");
      assert.equal(previewWrite.body.topic, "rodent pressure");

      await page.getByRole("button", { name: "Automation", exact: true }).click();
      await page.getByText("Blog RSS Feed", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Run Audit", exact: true }).click();
      await page.getByText("Approve this draft", { exact: true }).waitFor();
      await capture("audit");
      await page.getByRole("button", { name: "Approve & Publish", exact: true }).click();
      const approveWrite = report.requests.filter((item) => item.width === width && item.path.endsWith("/run-1/approve")).at(-1);
      assert.deepEqual({ method: approveWrite.method, body: approveWrite.body }, { method: "POST", body: { variantIndex: 0 } });

      await page.getByRole("button", { name: "Review Graphics", exact: true }).first().click();
      await page.getByText("Taylor Example", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Competitors", exact: true }).click();
      await page.getByText("Synthetic Competitor", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Analytics", exact: true }).click();
      await page.getByText("Performance by Platform", { exact: true }).waitFor();
      await capture("analytics");
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    try { if (browser) await browser.close(); }
    finally { await server.close(); }
  }
  console.log(`Admin social foundation proof passed: ${report.scenarios.length} viewport states. Evidence: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
