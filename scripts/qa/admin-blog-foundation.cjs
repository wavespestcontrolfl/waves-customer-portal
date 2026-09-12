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
  if (url.pathname === "/api/admin/content/blog/post-17" && method === "PUT")
    return { post };
  if (url.pathname === "/api/admin/content/blog/post-17" && method === "GET")
    return { post };
  if (url.pathname === "/api/admin/content/generate" && method === "POST")
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

function tokenViolations() {
  const visible = (node) =>
    node.getClientRects().length > 0 && !node.closest("[hidden], [inert]");
  const rgb = (value) => {
    const match = value.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
    );
    return match
      ? [
          Number(match[1]),
          Number(match[2]),
          Number(match[3]),
          Number(match[4] ?? 1),
        ]
      : null;
  };
  const allowed = (value) => {
    const color = rgb(value);
    if (!color || color[3] === 0) return true;
    const [red, green, blue] = color;
    const neutral =
      Math.max(red, green, blue) - Math.min(red, green, blue) <= 12;
    const alertRed = red > green && Math.abs(green - blue) <= 6;
    return neutral || alertRed;
  };
  const failures = [];
  for (const node of document.querySelectorAll(".admin-blog-token-scope *")) {
    if (!visible(node)) continue;
    const style = getComputedStyle(node);
    for (const property of [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
    ]) {
      if (!allowed(style[property])) {
        failures.push({
          text: node.textContent.trim().slice(0, 50),
          property,
          value: style[property],
        });
      }
    }
    if (node.tagName === "BUTTON") {
      if (
        style.textTransform !== "uppercase" ||
        parseFloat(style.letterSpacing) < 0.7
      ) {
        failures.push({
          text: node.textContent.trim().slice(0, 50),
          property: "button-label",
          value: `${style.textTransform}/${style.letterSpacing}`,
        });
      }
    }
  }
  return failures;
}

function buttonContrastViolations() {
  const parseColor = (value) => {
    const match = value.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
    );
    return match
      ? [
          Number(match[1]),
          Number(match[2]),
          Number(match[3]),
          Number(match[4] ?? 1),
        ]
      : [0, 0, 0, 0];
  };
  const composite = (foreground, background, alpha = foreground[3]) => [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
  const backgroundFor = (node) => {
    if (!node) return [255, 255, 255, 1];
    const beneath = backgroundFor(node.parentElement);
    const own = parseColor(getComputedStyle(node).backgroundColor);
    return composite(own, beneath);
  };
  const luminance = (color) => {
    const channels = color.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (first, second) => {
    const light = Math.max(luminance(first), luminance(second));
    const dark = Math.min(luminance(first), luminance(second));
    return (light + 0.05) / (dark + 0.05);
  };

  return [...document.querySelectorAll(".admin-blog-token-scope button")]
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => {
      const style = getComputedStyle(node);
      const beneath = backgroundFor(node.parentElement);
      const background = composite(parseColor(style.backgroundColor), beneath);
      const text = composite(parseColor(style.color), background);
      const opacity = Number(style.opacity);
      const renderedBackground = composite(background, beneath, opacity);
      const renderedText = composite(text, beneath, opacity);
      return {
        text: node.textContent.trim().slice(0, 50),
        disabled: node.disabled,
        ratio: Number(contrast(renderedText, renderedBackground).toFixed(2)),
        color: style.color,
        background: style.backgroundColor,
        beneath: beneath.slice(0, 3).map((channel) => Math.round(channel)),
      };
    })
    .filter((result) => result.ratio < 4.5);
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
  let server;
  let browser;
  try {
    server = await previewServer(root, process.env.ADMIN_UI_PREVIEW_URL);
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
      await page.addInitScript(() => {
        localStorage.setItem("waves_admin_token", "synthetic-token");
        const browserFetch = window.fetch.bind(window);
        window.fetch = (input, init) =>
          String(input).includes("/api/admin/usage/track")
            ? Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              )
            : browserFetch(input, init);
        Object.defineProperty(navigator, "sendBeacon", {
          configurable: true,
          value: () => true,
        });
      });
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
        await page.evaluate(() =>
          Promise.allSettled(
            document.getAnimations().map((animation) => animation.finished),
          ),
        );
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
        assert.deepEqual(
          await page.evaluate(tokenViolations),
          [],
          `non-token color or button label in ${name} at ${width}`,
        );
        assert.deepEqual(
          await page.evaluate(buttonContrastViolations),
          [],
          `button contrast below 4.5:1 in ${name} at ${width}`,
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
              control.font >= 14 && control.height >= (width === 390 ? 44 : 24),
          ),
          `undersized control in ${name} at ${width}: ${JSON.stringify(controls)}`,
        );
        const shot = `${name}-${width}.png`;
        await page.screenshot({
          path: path.join(output, shot),
          fullPage: false,
          animations: "disabled",
        });
        report.screenshots.push(shot);
        report.scenarios.push({ width, name });
      };

      await page.goto(`${server.baseUrl}/qa-blog?tab=posts&status=draft`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const postRow = page.getByText(post.title, { exact: false }).first();
      await postRow.waitFor();
      await capture("posts");

      await postRow.click();
      const titleInput = page.locator("input").first();
      await titleInput.waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get("post"),
        "post-17",
        `editor bookmark at ${width}`,
      );
      const statusDot = page.locator('[data-qa="blog-status-dot"]').first();
      await statusDot.waitFor();
      const statusDotStyle = await statusDot.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          width: box.width,
          height: box.height,
          radius: style.borderRadius,
        };
      });
      assert.equal(
        statusDotStyle.width,
        5,
        `status dot width in editor at ${width}`,
      );
      assert.equal(
        statusDotStyle.height,
        5,
        `status dot height in editor at ${width}`,
      );
      assert.ok(
        statusDotStyle.radius === "50%" || statusDotStyle.radius === "999px",
        `status dot shape in editor at ${width}`,
      );
      await capture("editor");
      await titleInput.fill("Edited synthetic guide");
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/api/admin/content/blog/post-17"),
        ),
        page.getByRole("button", { name: "Save draft" }).click(),
      ]);
      await page.waitForURL((url) => !url.searchParams.has("post"));

      const blogNav = page.getByRole("navigation", { name: "Blog section" });
      await blogNav.getByRole("button", { name: "Generate" }).click();
      await page.getByText("FAWN Weather", { exact: true }).waitFor();
      await capture("generate-disabled");
      await page
        .getByPlaceholder("Describe the topic or paste a working title...")
        .fill("Synthetic refresh topic");
      await page.getByText("Page Refresh", { exact: true }).click();
      await page.getByRole("button", { name: "Sarasota", exact: true }).click();
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
    if (browser) await browser.close();
    if (server) await server.close();
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
