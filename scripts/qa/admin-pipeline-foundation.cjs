"use strict";
/* global localStorage, document, getComputedStyle, innerWidth */
// Synthetic frontend-only QA. Every API response is fulfilled in-process and
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
const output = path.join(root, ".tmp/admin-pipeline-foundation");
const leadsOnly = process.argv.includes("--leads-only");
const now = "2026-09-11T14:00:00.000Z";
const lead = {
  id: "lead-fixture",
  first_name: "Avery",
  last_name: "Example",
  phone: "+19415550100",
  email: "avery@example.test",
  status: "estimate_viewed",
  service_interest: "General Pest",
  lead_source_name: "Website",
  lead_source: "website",
  first_contact_at: now,
  last_contact_at: now,
  created_at: now,
  updated_at: now,
  response_time_minutes: 4,
};
const estimate = {
  id: "estimate-fixture",
  token: "fixture-customer-link",
  customerId: "customer-fixture",
  customerName: "Avery Example",
  customerPhone: "+19415550100",
  customerEmail: "avery@example.test",
  address: "100 Example Way, Bradenton, FL 34205",
  status: "viewed",
  createdAt: now,
  sentAt: now,
  viewedAt: now,
  lastViewedAt: now,
  viewCount: 2,
  monthlyTotal: 89,
  oneTimeTotal: 149,
  serviceInterest: "General Pest",
  serviceLines: [],
  source: "lead_webhook",
  isPriority: false,
  showOneTimeOption: false,
  billByInvoice: false,
};
const customer = {
  id: "customer-fixture",
  first_name: "Avery",
  last_name: "Example",
  phone: "+19415550100",
  email: "avery@example.test",
  address_line1: "100 Example Way",
  city: "Bradenton",
  state: "FL",
  zip: "34205",
  lead_source: "website",
  active: true,
};
const source = {
  id: "source-fixture",
  name: "Website",
  source_type: "website_organic",
  channel: "organic",
  // The real /admin/leads/sources payload (lead_sources.*) and the
  // component both key off is_active, not active — the QA fixture had
  // drifted from that field name, so every "active" row in the QA run
  // was actually rendered opacity-50 as if inactive.
  is_active: true,
  monthly_cost: 200,
  cost_type: "per_month",
  twilio_phone_number: "+19415550200",
  totalLeads: 12,
};

function bodyFor(url, method) {
  const p = url.pathname;
  if (p === "/api/admin/auth/me")
    return { id: "qa-admin", name: "Fixture operator", role: "admin" };
  if (p === "/api/admin/feature-flags") return { flags: {} };
  if (p.endsWith("/unread-count")) return { count: 0, conversations: 0 };
  if (p === "/api/admin/usage/track") return { ok: true };
  if (p === "/api/admin/leads") return { leads: [lead], total: 1 };
  if (p === "/api/admin/leads/sources") return { sources: [source] };
  if (p === "/api/admin/customers") return { customers: [customer], total: 1 };
  if (p === "/api/admin/dispatch/technicians") return { technicians: [] };
  if (p === "/api/admin/services") return { services: [] };
  if (p === "/api/admin/leads/analytics/overview")
    return {
      total: 12,
      won: 5,
      lost: 2,
      active: 5,
      conversionRate: 41.7,
      medianResponseTime: 4,
      recentMedianResponseTime: 3,
      cpa: 40,
      avgSpeedToLead: 4,
      openUnansweredCount: 1,
      speedToLeadSince: now,
      roi: 800,
    };
  if (p === "/api/admin/leads/analytics/funnel")
    return {
      funnel: [
        { stage: "new", label: "New", count: 3 },
        { stage: "estimate_viewed", label: "Estimate viewed", count: 2 },
      ],
    };
  if (p === "/api/admin/leads/analytics/by-source")
    return {
      sources: [
        {
          source,
          totalLeads: 12,
          conversions: 5,
          totalCost: 200,
          totalRevenue: 1800,
          roi: 800,
        },
      ],
    };
  if (p === "/api/admin/leads/analytics/by-channel")
    return {
      channels: [
        {
          channel: "Organic",
          totalLeads: 12,
          conversions: 5,
          totalCost: 200,
          totalRevenue: 1800,
          roi: 800,
        },
      ],
    };
  if (p === "/api/admin/leads/analytics/response")
    return {
      buckets: [
        {
          label: "Under 5 min",
          total: 8,
          won: 4,
          conversions: 4,
          conversionRate: 50,
        },
      ],
    };
  if (p === "/api/admin/leads/analytics/lost")
    return { reasons: [{ reason: "No response", count: 2 }] };
  if (p === "/api/admin/estimates/win-loss-slices")
    return {
      resolved: 0,
      byFlagField: [],
      recurringBandsByFlag: [],
      byDisposition: [],
      byServiceLine: [],
      byLeadSource: [],
      byWaveguardTier: [],
      sentCohorts: { cohorts: [] },
    };
  if (p === "/api/admin/estimates/source-performance")
    return { drafted: 0, resolved: 0, sources: [] };
  if (p === "/api/admin/estimates")
    return { estimates: [estimate], truncated: false };
  if (p === "/api/admin/customers/customer-fixture/estimates-summary")
    return {
      customer,
      estimates: [
        {
          id: estimate.id,
          token: estimate.token,
          status: estimate.status,
          monthly_total: estimate.monthlyTotal,
          created_at: now,
          service_interest: estimate.serviceInterest,
        },
      ],
      stats: {
        total: 1,
        accepted: 0,
        declined: 0,
        conversionRate: null,
        acceptedLifetimeMonthly: 0,
      },
      lastContact: null,
    };
  if (p === "/api/admin/customers/customer-fixture/comms") return { comms: [] };
  if (p === "/api/admin/leads/contact-matches")
    return { matches: [], total: 0 };
  if (p === "/api/admin/leads/lead-fixture")
    return { lead, activities: [], calls: [] };
  if (method !== "GET") return { ok: true };
  return null;
}

function visibleTypography(rootNode) {
  const visible = (node) =>
    node.getClientRects().length > 0 && !node.closest("[hidden], [inert]");
  return [...rootNode.querySelectorAll("*")]
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
  let server;
  let browser;
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [390, 768, 1024, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        hasTouch: width <= 768,
        timezoneId: "America/New_York",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.addInitScript(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
          const url = new URL(String(input), window.location.href);
          if (url.pathname === "/api/admin/usage/track")
            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          return realFetch(input, options);
        };
        localStorage.setItem("waves_admin_token", "synthetic-local-token");
        localStorage.setItem(
          "waves_admin_user",
          JSON.stringify({
            id: "qa-admin",
            name: "Fixture operator",
            role: "admin",
          }),
        );
      });
      await page.routeWebSocket("**/*", (socket) => socket.close());
      page.on("pageerror", (error) =>
        report.pageErrors.push(`${width}: ${error.message}`),
      );
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.origin !== server.baseUrl ||
          url.pathname.startsWith("/socket.io")
        )
          return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const key = `${request.method()} ${url.pathname}`;
        report.requests.push({ width, key, search: url.search });
        const body = bodyFor(url, request.method());
        if (body == null) {
          report.unmatched.push(key);
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: "Unmatched synthetic fixture" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.goto(`${server.baseUrl}/admin/pipeline?tab=leads`, {
        timeout: 60000,
      });
      await page
        .getByRole("button", { name: "Avery Example", exact: true })
        .waitFor();
      await waitForFonts(page);
      assert.equal(
        await page
          .locator(".ui-surface")
          .first()
          .getAttribute("data-ui-density"),
        "comfortable",
      );
      await page.getByRole("button", { name: "New lead", exact: true }).click();
      const newLead = page.getByRole("dialog", { name: "New lead" });
      await newLead.waitFor();
      await newLead.getByLabel("Phone").fill("+19415550999");
      assert.deepEqual(
        await newLead.evaluate(visibleTypography),
        [],
        `New lead dialog text below 14px at ${width}`,
      );
      await newLead.getByRole("button", { name: "Close" }).click();
      if (width < 768) {
        await page.getByRole("button", { name: /Filters/ }).click();
        await page
          .getByRole("combobox", { name: "View", exact: true })
          .selectOption("board");
      } else
        await page.getByRole("button", { name: "Board", exact: true }).click();
      await page.getByRole("region", { name: "Lead board" }).waitFor();
      await page.getByRole("button", { name: "Sources", exact: true }).click();
      await page.getByText("Lead Sources (1)").waitFor();
      // is_active: true on the fixture source — assert the active-row
      // presentation (no opacity-50), not just that the row exists, so a
      // regression back to the inactive treatment for active sources would
      // be caught here.
      assert.doesNotMatch(
        (await page.getByRole("row", { name: /Website/ }).getAttribute(
          "class",
        )) || "",
        /opacity-50/,
        `active source row rendered opacity-50 at ${width}`,
      );
      const analyticsButton = page.getByRole("button", {
        name: "Analytics",
        exact: true,
      });
      await analyticsButton.click();
      await page.getByText("Channel comparison").waitFor();
      await page.getByText("Organic", { exact: true }).waitFor();
      assert.equal(await analyticsButton.getAttribute("aria-current"), "page");
      assert.match(await analyticsButton.getAttribute("class"), /bg-zinc-900/);
      await page.mouse.move(0, 0);
      await analyticsButton.evaluate((node) =>
        Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
      assert.deepEqual(
        await analyticsButton.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            backgroundColor: style.backgroundColor,
            color: style.color,
          };
        }),
        {
          backgroundColor: "rgb(24, 24, 27)",
          color: "rgb(255, 255, 255)",
        },
        `Selected analytics control contrast at ${width}`,
      );
      const leadsShot = path.join(output, `leads-${width}.png`);
      await page.screenshot({ path: leadsShot, fullPage: true });
      report.screenshots.push(leadsShot);
      assert.deepEqual(
        await page.locator(".ui-surface").first().evaluate(visibleTypography),
        [],
        `Leads surface text below 14px at ${width}`,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `Leads overflow at ${width}`,
      );
      if (leadsOnly) {
        report.scenarios.push({
          width,
          leadsList: true,
          leadDialog: true,
          board: true,
          sources: true,
          analytics: true,
        });
        await context.close();
        continue;
      }

      await page
        .getByRole("button", { name: "Estimates", exact: true })
        .click();
      await page.getByText("Avery Example", { exact: true }).first().waitFor();
      const action = page.getByRole("button", {
        name: "Actions for Avery Example",
      });
      await action.click();
      const actionsDialog = page.getByRole("dialog", { name: "Actions" });
      await actionsDialog.waitFor();
      assert.equal(
        await actionsDialog.evaluate((node) => node.style.zIndex),
        "120",
      );
      assert.deepEqual(
        await actionsDialog.evaluate(visibleTypography),
        [],
        `Actions dialog text below 14px at ${width}`,
      );
      await actionsDialog
        .getByRole("button", { name: "Close actions menu" })
        .click();
      if (width >= 768) {
        await page.getByRole("button", { name: "Follow Up", exact: true }).click();
        const followUpDialog = page.getByRole("dialog", {
          name: `Follow Up — ${estimate.customerName}`,
        });
        await followUpDialog.getByLabel("SMS Message").waitFor();
        assert.deepEqual(
          await followUpDialog.evaluate(visibleTypography),
          [],
          `Follow-up dialog text below 14px at ${width}`,
        );
        const followUpShot = path.join(output, `follow-up-${width}.png`);
        await page.screenshot({ path: followUpShot, fullPage: true });
        report.screenshots.push(followUpShot);
        await followUpDialog.getByRole("button", { name: "Cancel" }).click();
      }
      const customerButton =
        width < 768
          ? page.getByRole("button", {
              name: "Open Avery Example customer estimate history",
              exact: true,
            })
          : page
              .getByRole("button", { name: "Avery Example", exact: true })
              .first();
      await customerButton.click();
      const customerSheet = page.getByRole("dialog", {
        name: "Customer + estimate history",
      });
      await customerSheet.getByText("Estimate history (1)").waitFor();
      assert.deepEqual(
        await customerSheet.evaluate(visibleTypography),
        [],
        `Customer sheet text below 14px at ${width}`,
      );
      const estimatesShot = path.join(output, `estimates-${width}.png`);
      await page.screenshot({ path: estimatesShot, fullPage: true });
      report.screenshots.push(estimatesShot);
      await customerSheet
        .getByRole("button", { name: "Back to estimates" })
        .click();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `Estimates overflow at ${width}`,
      );
      report.scenarios.push({
        width,
        leadsList: true,
        leadDialog: true,
        board: true,
        sources: true,
        analytics: true,
        estimates: true,
        actionsDialog: true,
        followUpDialog: width >= 768,
        customerSheet: true,
      });
      await context.close();
    }
    assert.deepEqual([...new Set(report.unmatched)], []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await server?.close();
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      scenarios: report.scenarios.length,
      screenshots: report.screenshots.length,
      output,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
