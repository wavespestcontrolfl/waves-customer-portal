"use strict";
// SYNTHETIC UI QA. Only the local frontend runs; every API is intercepted.
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
const output = path.join(root, ".tmp/admin-referrals-foundation");

const promoterFixture = {
  id: "promoter-1",
  first_name: "Morgan",
  last_name: "Example",
  customer_phone: "9415550101",
  referral_code: "MORGAN1",
  referral_link: "https://example.invalid/ref/MORGAN1",
  total_clicks: 8,
  total_referrals_converted: 2,
  total_referrals_sent: 3,
  total_earned_cents: 5000,
  available_balance_cents: 2500,
  pending_earnings_cents: 1000,
  milestone_level: "advocate",
};

const referralFixture = {
  id: "referral-1",
  referral_first_name: "Avery",
  referral_last_name: "Example",
  referral_phone: "9415550102",
  referral_email: "avery@example.invalid",
  promoter_first: "Morgan",
  promoter_last: "Example",
  source: "admin",
  status: "pending",
};

const payoutFixture = {
  id: "payout-1",
  first_name: "Morgan",
  last_name: "Example",
  amount_cents: 2500,
  method: "service_credit",
  status: "pending",
  requires_1099: false,
};

const settingsFixture = {
  referrer_reward_cents: 2500,
  referee_discount_cents: 2500,
  bonus_silver_cents: 500,
  bonus_gold_cents: 1000,
  bonus_platinum_cents: 1500,
  milestone_3_bonus_cents: 500,
  milestone_5_bonus_cents: 1000,
  milestone_10_bonus_cents: 2500,
  max_referrals_per_month: 10,
  cooldown_days: 30,
  min_payout_cents: 2500,
  program_active: true,
  auto_credit_enabled: false,
  require_service_completion: true,
  base_url: "https://example.invalid/refer",
  invite_sms_template: "Share your referral link: {{referral_link}}",
  reward_sms_template: "Your referral reward is ready.",
  milestone_sms_template: "You reached a referral milestone.",
};

const analyticsFixture = {
  funnel: {
    clicks: 24,
    uniqueClicks: 18,
    referrals: 6,
    clickToReferralRate: 25,
    converted: 3,
    conversionRate: 50,
    lost: 1,
    pending: 2,
  },
  financial: {
    totalRewardsDollars: 75,
    totalPaidOutCents: 2500,
    totalMonthlyValue: 237,
    estimatedAnnualRevenue: 2844,
    roi: 3692,
  },
  topPromoters: [
    {
      id: "promoter-1",
      name: "Morgan Example",
      conversions: 2,
      earned: 5000,
      milestone: "advocate",
    },
  ],
};

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    passed: false,
    scenarios: [],
    checks: [],
    requests: [],
    unmatched: [],
    errors: [],
    screenshots: [],
    geometry: [],
    contrast: [],
  };
  let server;
  let browser;
  let stage = "startup";
  const check = (name, condition) => {
    assert.ok(condition, name);
    report.checks.push(name);
  };

  async function openPage(width, mode = "populated", delayInitial = false) {
    const state = {
      mode,
      failReferrals: mode === "error",
      delayInitial,
      referral: structuredClone(referralFixture),
      payout: structuredClone(payoutFixture),
      settings: structuredClone(settingsFixture),
    };
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      hasTouch: width < 1024,
      timezoneId: "America/New_York",
      serviceWorkers: "block",
    });
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(60000);
    page.on("pageerror", (error) =>
      report.errors.push({ stage, message: error.message }),
    );
    await page.addInitScript(() => {
      localStorage.setItem("waves_admin_token", "synthetic-token");
      localStorage.setItem(
        "waves_admin_user",
        JSON.stringify({
          id: "fixture-owner",
          name: "Fixture owner",
          role: "admin",
        }),
      );
      navigator.sendBeacon = () => true;
      if (navigator.serviceWorker)
        navigator.serviceWorker.register = async () => ({
          scope: "synthetic-local-test",
        });
    });
    await page.routeWebSocket("**/*", (socket) => socket.close());
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const api = url.pathname.slice(4);
      const record = {
        stage,
        width,
        mode,
        method: request.method(),
        path: api,
        query: url.search,
      };
      if (request.method() !== "GET") record.payload = request.postDataJSON();
      report.requests.push(record);
      if (state.delayInitial && api.startsWith("/admin/referrals")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state.delayInitial = false;
      }
      let body;
      let status = 200;
      if (api === "/health") body = { status: "ok", gates: {} };
      else if (api === "/admin/auth/me")
        body = {
          id: "fixture-owner",
          name: "Fixture owner",
          email: "owner@example.invalid",
          role: "admin",
        };
      else if (api === "/admin/feature-flags")
        body = { flags: { "admin-navigation": true } };
      else if (api === "/admin/notifications/unread-count") body = { count: 0 };
      else if (api === "/admin/communications/unread-count")
        body = { conversations: 0 };
      else if (api === "/admin/usage/track") body = {};
      else if (api.startsWith("/admin/referrals") && state.failReferrals) {
        status = 503;
        body = { error: "Synthetic referral outage" };
      } else if (api === "/admin/referrals/stats")
        body =
          state.mode === "empty"
            ? {
                activePromoters: 0,
                totalReferrals: 0,
                convertedReferrals: 0,
                pendingReferrals: 0,
                totalRewardsDollars: 0,
                totalPaidOutCents: 0,
                pendingPayouts: 0,
                programROI: 0,
              }
            : {
                activePromoters: 1,
                totalReferrals: 3,
                convertedReferrals: 2,
                pendingReferrals: 1,
                totalRewardsDollars: 50,
                totalPaidOutCents: 2500,
                pendingPayouts: 1,
                programROI: 3200,
              };
      else if (api === "/admin/referrals/promoters")
        body = { promoters: state.mode === "empty" ? [] : [promoterFixture] };
      else if (api === "/admin/referrals/queue") {
        // Mirror server/routes/admin-referrals-v2.js:124-130 — with no
        // ?status= query param (the client never sends one), the real route
        // filters the default queue to pending/contacted/estimated/
        // sms_failed, so a converted (signed_up) referral drops out of it.
        const DEFAULT_QUEUE_STATUSES = [
          "pending",
          "contacted",
          "estimated",
          "sms_failed",
        ];
        const statusParam = url.searchParams.get("status");
        const inQueue =
          state.mode !== "empty" &&
          (statusParam
            ? state.referral.status === statusParam
            : DEFAULT_QUEUE_STATUSES.includes(state.referral.status));
        body = { referrals: inQueue ? [state.referral] : [] };
      } else if (api === "/admin/referrals/payouts")
        body = { payouts: state.mode === "empty" ? [] : [state.payout] };
      else if (
        api === "/admin/referrals/settings" &&
        request.method() === "GET"
      )
        body = { settings: state.settings };
      else if (
        api === "/admin/referrals/settings" &&
        request.method() === "PUT"
      ) {
        state.settings = request.postDataJSON();
        body = { settings: state.settings };
      } else if (api === "/admin/referrals/analytics")
        body =
          state.mode === "empty"
            ? {
                funnel: {
                  clicks: 0,
                  uniqueClicks: 0,
                  referrals: 0,
                  clickToReferralRate: 0,
                  converted: 0,
                  conversionRate: 0,
                  lost: 0,
                  pending: 0,
                },
                financial: {
                  totalRewardsDollars: 0,
                  totalPaidOutCents: 0,
                  totalMonthlyValue: 0,
                  estimatedAnnualRevenue: 0,
                  roi: 0,
                },
                topPromoters: [],
              }
            : analyticsFixture;
      else if (api === "/admin/customers")
        body = {
          customers: [
            {
              id: "customer-1",
              first_name: "Avery",
              last_name: "Example",
              phone: "9415550102",
            },
          ],
        };
      else if (api === "/admin/referrals/submit" && request.method() === "POST")
        body = { referral: state.referral };
      else if (
        api === "/admin/referrals/referral-1/status" &&
        request.method() === "PATCH"
      ) {
        state.referral.status = request.postDataJSON().status;
        body = { success: true };
      } else if (
        api === "/admin/referrals/referral-1/convert" &&
        request.method() === "POST"
      ) {
        state.referral.status = "signed_up";
        body = { referral: state.referral };
      } else if (
        api === "/admin/referrals/enroll" &&
        request.method() === "POST"
      )
        body = { promoter: promoterFixture };
      else if (
        api === "/admin/referrals/payouts/payout-1/approve" &&
        request.method() === "POST"
      ) {
        state.payout.status = "applied";
        body = { success: true };
      } else {
        report.unmatched.push(record);
        status = 500;
        body = { error: "Unmatched synthetic request" };
      }
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    return { page, state };
  }

  async function screenshot(page, name) {
    await waitForFonts(page);
    const file = `${name}.png`;
    check(
      `${name} fits the viewport`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: path.join(output, file),
      fullPage: true,
      animations: "disabled",
    });
    report.screenshots.push(file);
  }

  async function geometry(page, name) {
    const measurements = await page
      .locator(
        'button[style*="font-size"], input[style*="font-size"], textarea[style*="font-size"], select[style*="font-size"]',
      )
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getClientRects().length)
          .map((node) => ({
            tag: node.tagName,
            name:
              node.getAttribute("aria-label") ||
              node.textContent.trim() ||
              node.id,
            height: node.getBoundingClientRect().height,
            font: parseFloat(getComputedStyle(node).fontSize),
          })),
      );
    check(`${name} has original inline controls`, measurements.length > 0);
    for (const item of measurements) {
      check(
        `${name} ${item.name || item.tag} has readable text`,
        item.font >= 14,
      );
    }
    const undersizedText = await page
      .locator('[style*="font-size"]')
      .evaluateAll((nodes) =>
        nodes
          .filter(
            (node) =>
              node.getClientRects().length &&
              [...node.childNodes].some(
                (child) =>
                  child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
              ),
          )
          .map((node) => ({
            text: node.textContent.trim(),
            font: parseFloat(getComputedStyle(node).fontSize),
          }))
          .filter((item) => item.font < 14),
      );
    check(
      `${name} keeps readable local text at 14px`,
      undersizedText.length === 0,
    );
    const buttonCase = await page
      .locator('button[style*="font-size"]')
      .evaluateAll((nodes) =>
        nodes
          .filter(
            (node) => node.getClientRects().length && node.textContent.trim(),
          )
          .map((node) => ({
            name: node.textContent.trim(),
            transform: getComputedStyle(node).textTransform,
            spacing: getComputedStyle(node).letterSpacing,
          })),
      );
    for (const item of buttonCase) {
      check(
        `${name} ${item.name} uses uppercase CTA styling`,
        item.transform === "uppercase" && parseFloat(item.spacing) > 0,
      );
    }
    report.geometry.push({ name, measurements });
  }

  async function assertButtonContrast(page, name, labels) {
    const results = [];
    for (const label of labels) {
      const result = await page
        .getByRole("button", { name: label, exact: true })
        .evaluate((node) => {
          const parseColor = (value) => {
            const channels = value.match(/[\d.]+/g).map(Number);
            return {
              r: channels[0],
              g: channels[1],
              b: channels[2],
              a: channels[3] ?? 1,
            };
          };
          const composite = (top, bottom) => ({
            r: top.r * top.a + bottom.r * (1 - top.a),
            g: top.g * top.a + bottom.g * (1 - top.a),
            b: top.b * top.a + bottom.b * (1 - top.a),
            a: 1,
          });
          const effectiveBackground = (element) => {
            const underneath = element.parentElement
              ? effectiveBackground(element.parentElement)
              : { r: 255, g: 255, b: 255, a: 1 };
            return composite(
              parseColor(getComputedStyle(element).backgroundColor),
              underneath,
            );
          };
          const luminance = ({ r, g, b }) => {
            const channels = [r, g, b].map((channel) => {
              const srgb = channel / 255;
              return srgb <= 0.04045
                ? srgb / 12.92
                : ((srgb + 0.055) / 1.055) ** 2.4;
            });
            return (
              0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
            );
          };
          const style = getComputedStyle(node);
          const background = effectiveBackground(node);
          const foreground = composite(parseColor(style.color), background);
          const lighter = Math.max(
            luminance(foreground),
            luminance(background),
          );
          const darker = Math.min(luminance(foreground), luminance(background));
          return {
            foreground: style.color,
            background: style.backgroundColor,
            ratio: (lighter + 0.05) / (darker + 0.05),
          };
        });
      check(
        `${name} ${label} meets 4.5:1 rendered contrast`,
        result.ratio >= 4.5,
      );
      results.push({ label, ...result });
    }
    report.contrast.push({ name, results });
    return results;
  }

  async function scenario(name, run) {
    stage = name;
    await run();
    report.scenarios.push({ name, passed: true });
  }

  async function closePage(page) {
    await page.evaluate(() => localStorage.removeItem("waves_admin_token"));
    await page.close();
  }

  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    await scenario("initial loading feedback", async () => {
      const { page } = await openPage(390, "populated", true);
      await page.goto(`${server.baseUrl}/admin/referrals`);
      await page
        .getByText("Loading referral program...", { exact: true })
        .waitFor();
      check("initial load keeps visible feedback", true);
      await page.getByText("Recent Activity", { exact: true }).waitFor();
      await closePage(page);
    });
    await scenario("alert status tokens", async () => {
      const { page, state } = await openPage(390);
      state.referral.status = "sms_failed";
      await page.goto(`${server.baseUrl}/admin/referrals`);
      const alertStatus = page.getByText("sms failed", { exact: true }).first();
      await alertStatus.waitFor();
      check(
        "failed status uses the alert text and dot tokens",
        await alertStatus.evaluate((node) => {
          const textStyle = getComputedStyle(node);
          const dotStyle = getComputedStyle(node.firstElementChild);
          return (
            textStyle.color === "rgb(163, 45, 45)" &&
            dotStyle.backgroundColor === "rgb(200, 49, 47)"
          );
        }),
      );
      await closePage(page);
    });
    for (const width of [390, 820, 1440]) {
      await scenario(`populated route and actions at ${width}`, async () => {
        const { page } = await openPage(width);
        await page.goto(`${server.baseUrl}/admin/referrals`);
        await page.getByText("Recent Activity", { exact: true }).waitFor();
        check(
          `${width} uses the real Referrals route`,
          new URL(page.url()).pathname === "/admin/referrals",
        );
        await screenshot(page, `dashboard-populated-${width}`);
        await geometry(page, `dashboard-${width}`);
        const activeMetric = page
          .getByText("Active Promoters", { exact: true })
          .locator("..");
        check(
          `${width} ordinary metrics use zinc ink`,
          (await activeMetric
            .locator("div")
            .nth(1)
            .evaluate((node) => getComputedStyle(node).color)) ===
            "rgb(9, 9, 11)",
        );
        const pendingStatus = page
          .getByText("pending", { exact: true })
          .first();
        check(
          `${width} queued status uses a hollow local dot`,
          await pendingStatus.locator("span").evaluate((node) => {
            const style = getComputedStyle(node);
            return (
              node.getBoundingClientRect().width === 5 &&
              style.backgroundColor === "rgba(0, 0, 0, 0)" &&
              style.borderTopWidth === "1px"
            );
          }),
        );

        await page
          .getByRole("button", { name: "Analytics", exact: true })
          .click();
        await page.getByText("Conversion Funnel", { exact: true }).waitFor();
        const chartValue = page.getByText("2 conv / $50.00", { exact: true });
        check(
          `${width} chart ink and bar use zinc without a gradient`,
          await chartValue.evaluate((node) => {
            const labelStyle = getComputedStyle(node);
            const bar = node.parentElement.nextElementSibling.firstElementChild;
            const barStyle = getComputedStyle(bar);
            return (
              labelStyle.color === "rgb(63, 63, 70)" &&
              barStyle.backgroundColor === "rgb(9, 9, 11)" &&
              barStyle.backgroundImage === "none"
            );
          }),
        );
        await screenshot(page, `analytics-populated-${width}`);

        await page
          .getByRole("button", { name: "Queue (1)", exact: true })
          .click();
        await page
          .getByPlaceholder("Friend's name *", { exact: true })
          .fill("Taylor Example");
        await page
          .getByPlaceholder("Phone *", { exact: true })
          .fill("9415550199");
        await page
          .getByPlaceholder("Email", { exact: true })
          .fill("taylor@example.invalid");
        await page
          .getByPlaceholder("Promoter ID", { exact: true })
          .fill("promoter-1");
        await page
          .getByPlaceholder("Address", { exact: true })
          .fill("Synthetic location");
        await page
          .getByPlaceholder("Notes", { exact: true })
          .fill("Synthetic browser check");
        await Promise.all([
          page.waitForResponse((response) =>
            response.url().endsWith("/api/admin/referrals/submit"),
          ),
          page.getByRole("button", { name: "Submit", exact: true }).click(),
        ]);
        const submit = report.requests
          .filter(
            (request) =>
              request.path === "/admin/referrals/submit" &&
              request.width === width,
          )
          .at(-1);
        assert.deepEqual(submit.payload, {
          promoterId: "promoter-1",
          name: "Taylor Example",
          phone: "9415550199",
          email: "taylor@example.invalid",
          address: "Synthetic location",
          notes: "Synthetic browser check",
        });

        const queueContrast = await assertButtonContrast(
          page,
          `queue-${width}`,
          ["Contacted", "Convert", "Reject"],
        );
        check(
          `${width} neutral queue actions use light text on zinc`,
          queueContrast
            .filter(({ label }) => label !== "Reject")
            .every(
              ({ foreground, background }) =>
                foreground === "rgb(255, 255, 255)" &&
                ["rgb(24, 24, 27)", "rgb(63, 63, 70)"].includes(background),
            ),
        );
        const rejectContrast = queueContrast.find(
          ({ label }) => label === "Reject",
        );
        check(
          `${width} Reject uses alert text on a white surface`,
          rejectContrast.foreground === "rgb(163, 45, 45)" &&
            rejectContrast.background === "rgb(255, 255, 255)",
        );

        await page
          .getByRole("button", { name: "Contacted", exact: true })
          .click();
        await page.getByText("contacted", { exact: true }).waitFor();
        const status = report.requests
          .filter(
            (request) =>
              request.path.endsWith("/status") && request.width === width,
          )
          .at(-1);
        assert.deepEqual(status.payload, { status: "contacted" });
        const convertTrigger = page.getByRole("button", {
          name: "Convert",
          exact: true,
        });
        await convertTrigger.click();
        const convertDialog = page
          .getByText("Convert Referral", { exact: true })
          .locator("..");
        await convertDialog
          .getByPlaceholder("Search customer name or phone...", {
            exact: true,
          })
          .fill("Avery");
        await convertDialog
          .getByText("Avery Example (9415550102)", { exact: true })
          .click();
        await convertDialog.locator("select").selectOption("Gold");
        await convertDialog
          .getByPlaceholder("e.g. 79", { exact: true })
          .fill("79");
        await screenshot(page, `convert-dialog-${width}`);
        await geometry(page, `convert-dialog-${width}`);
        await Promise.all([
          page.waitForResponse((response) =>
            response.url().endsWith("/api/admin/referrals/referral-1/convert"),
          ),
          convertDialog
            .getByRole("button", { name: "Convert", exact: true })
            .click(),
        ]);
        assert.deepEqual(
          report.requests
            .filter(
              (request) =>
                request.path.endsWith("/convert") && request.width === width,
            )
            .at(-1).payload,
          { customerId: "customer-1", tier: "Gold", monthlyValue: "79" },
        );
        // The queue reload after conversion refetches
        // /admin/referrals/queue, which (server/routes/admin-referrals-v2.js
        // :124-130) filters the default queue to
        // pending/contacted/estimated/sms_failed — a signed_up referral is
        // no longer in it at all, not just missing its Convert action. With
        // only one fixture referral, the row disappears entirely and the
        // Queue tab falls back to its empty state; checking focus landed
        // back on the (now-gone) trigger would just time out, so confirm
        // the real post-conversion contract instead: the row is gone, the
        // count heading reflects zero, and the empty state is shown.
        await page.getByText("Referral Queue (0)", { exact: true }).waitFor();
        await page.getByText("No pending referrals", { exact: true }).waitFor();
        check(
          `${width} convert removes the referral from the queue once signed up`,
          (await convertTrigger.count()) === 0,
        );

        await page
          .getByRole("button", { name: "Promoters", exact: true })
          .click();
        await page
          .getByPlaceholder("Search promoters...", { exact: true })
          .waitFor();
        const enrollTrigger = page.getByRole("button", {
          name: "Enroll Customer",
          exact: true,
        });
        await enrollTrigger.click();
        const enrollDialog = page
          .getByText("Enroll Customer as Promoter", { exact: true })
          .locator("..");
        await enrollDialog
          .getByPlaceholder("Search customer name or phone...", {
            exact: true,
          })
          .fill("Avery");
        await Promise.all([
          page.waitForResponse((response) =>
            response.url().endsWith("/api/admin/referrals/enroll"),
          ),
          enrollDialog
            .getByText("Avery Example (9415550102)", { exact: true })
            .click(),
        ]);
        assert.deepEqual(
          report.requests
            .filter(
              (request) =>
                request.path === "/admin/referrals/enroll" &&
                request.width === width,
            )
            .at(-1).payload,
          { customerId: "customer-1" },
        );
        // Main replaces the whole page with loading feedback while load()
        // refreshes the data after a successful enrollment.
        await enrollDialog.waitFor({ state: "hidden" });
        await page
          .getByRole("button", { name: "Enroll Customer", exact: true })
          .waitFor();
        check(`${width} promoters tab recovers after enrolling`, true);

        await page
          .getByRole("button", { name: "Payouts", exact: true })
          .click();
        const [approveContrast] = await assertButtonContrast(
          page,
          `payouts-${width}`,
          ["Approve"],
        );
        check(
          `${width} Approve uses light text on zinc`,
          approveContrast.foreground === "rgb(255, 255, 255)" &&
            approveContrast.background === "rgb(63, 63, 70)",
        );
        await Promise.all([
          page.waitForResponse((response) =>
            response
              .url()
              .endsWith("/api/admin/referrals/payouts/payout-1/approve"),
          ),
          page.getByRole("button", { name: "Approve", exact: true }).click(),
        ]);
        assert.deepEqual(
          report.requests
            .filter(
              (request) =>
                request.path.endsWith("/approve") && request.width === width,
            )
            .at(-1).payload,
          {},
        );
        const appliedStatus = page.getByText("applied", { exact: true });
        await appliedStatus.waitFor();
        check(
          `${width} completed status uses a hollow tertiary dot`,
          await appliedStatus.locator("span").evaluate((node) => {
            const style = getComputedStyle(node);
            return (
              style.backgroundColor === "rgba(0, 0, 0, 0)" &&
              style.borderTopColor === "rgb(113, 113, 122)"
            );
          }),
        );

        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Edit Settings", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Edit Settings", exact: true })
          .click();
        await page
          .getByText("Referrer Reward (cents)", { exact: true })
          .locator("..")
          .locator("input")
          .fill("3000");
        await page
          .getByRole("button", { name: "Disabled", exact: true })
          .click();
        await screenshot(page, `settings-edit-${width}`);
        await geometry(page, `settings-edit-${width}`);
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/admin/referrals/settings") &&
              response.request().method() === "PUT",
          ),
          page.getByRole("button", { name: "Save", exact: true }).click(),
        ]);
        const savedSettings = report.requests
          .filter(
            (request) =>
              request.path === "/admin/referrals/settings" &&
              request.method === "PUT" &&
              request.width === width,
          )
          .at(-1).payload;
        check(
          `${width} settings keep the complete payload`,
          savedSettings.referrer_reward_cents === 3000 &&
            savedSettings.auto_credit_enabled === true &&
            Object.keys(savedSettings).length ===
              Object.keys(settingsFixture).length,
        );
        await closePage(page);
      });

      await scenario(`empty state at ${width}`, async () => {
        const { page } = await openPage(width, "empty");
        await page.goto(`${server.baseUrl}/admin/referrals`);
        await page.getByText("No referrals yet", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Queue (0)", exact: true })
          .click();
        await page.getByText("No pending referrals", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Promoters", exact: true })
          .click();
        await page
          .getByPlaceholder("Search promoters...", { exact: true })
          .waitFor();
        check(
          `${width} promoters table has no rows when empty`,
          (await page.locator("table tbody tr").count()) === 0,
        );
        await screenshot(page, `promoters-empty-${width}`);
        await closePage(page);
      });

      // Main silently degrades a failed initial load (each list falls back to
      // an empty value, `stats` stays null) rather than surfacing an error —
      // this scenario locks in that this migration kept the same behavior.
      await scenario(`load failure degrades quietly at ${width}`, async () => {
        const { page } = await openPage(width, "error");
        await page.goto(`${server.baseUrl}/admin/referrals`);
        await page.getByText("Referrals", { exact: true }).first().waitFor();
        check(
          `${width} dashboard renders nothing when stats fails to load`,
          (await page.getByText("Recent Activity").count()) === 0,
        );
        await page
          .getByRole("button", { name: "Queue (0)", exact: true })
          .click();
        await page.getByText("No pending referrals", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Promoters", exact: true })
          .click();
        await page
          .getByPlaceholder("Search promoters...", { exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Payouts", exact: true })
          .click();
        await page.getByText("No payout requests", { exact: true }).waitFor();
        check(`${width} no pageerror on a fully-failed load`, true);
        await screenshot(page, `load-failure-${width}`);
        await closePage(page);
      });
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await server?.close();
  }
  process.stdout.write(
    `${report.scenarios.length} referral scenarios and ${report.checks.length} checks passed; evidence: ${output}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
