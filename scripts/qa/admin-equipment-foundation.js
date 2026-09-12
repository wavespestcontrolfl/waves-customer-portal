"use strict";
/* global document, localStorage, navigator, getComputedStyle, innerWidth, requestAnimationFrame, history, window, MutationObserver */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { webkit } = require("playwright");
const {
  previewServer,
  launchBrowser,
  evidence,
  waitForFonts,
} = require("./browser");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, ".tmp/admin-equipment-foundation");
const id = "00000000-0000-4000-8000-000000000001",
  systemId = "00000000-0000-4000-8000-000000000002",
  calibrationId = "00000000-0000-4000-8000-000000000003";
// Every date these fixtures serve is generated relative to the run. Pinning
// them meant the runner kept asserting a response production could no longer
// return: a schedule a few weeks out becomes overdue once that date passes, a
// calibration expires, and mileage rows drop out of the year that
// /mileage/summary and getFleetOverview filter on.
const easternToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(),
  );
function easternYear() {
  return Number(easternToday().slice(0, 4));
}
function easternDate(offsetDays) {
  const [year, month, day] = easternToday().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + offsetDays))
    .toISOString()
    .slice(0, 10);
}
// Anchored to the run date but never earlier than the year start, so the
// endpoints that filter on the current year always have the baseline row to
// report — otherwise the analytics pass would find an empty fleet for the first
// few days of January.
function recentEasternDate(daysAgo) {
  const candidate = easternDate(-daysAgo),
    yearStart = `${easternYear()}-01-01`;
  return candidate > yearStart ? candidate : yearStart;
}
const scheduleDueAt = easternDate(20),
  mileageLogDate = recentEasternDate(3),
  maintenanceAt = `${recentEasternDate(10)}T12:00:00Z`,
  jobServiceDate = recentEasternDate(6),
  calibrationExpiresAt = `${easternDate(30)}T12:00:00Z`;
const equipment = {
  id,
  name: "Example service truck",
  category: "vehicle",
  make: "Example",
  model: "Pickup",
  status: "active",
  asset_tag: "QA-001",
  year: 2024,
  serial_number: "SYNTHETIC-001",
  vin: "SYNTHETIC-VIN",
  purchase_date: "2024-01-01",
  purchase_price: 25000,
  book_value: 20000,
  current_hours: 150,
  current_miles: 12000,
  next_service_hours: 180,
  next_service_type: "Synthetic inspection",
  assigned_tech_name: "Fixture operator",
  condition_rating: 8,
  location: "Example shop",
  engine_type: "Gas",
  depreciation_method: "MACRS",
  next_maintenance: {
    task_name: "Synthetic inspection",
    next_due_at: scheduleDueAt,
    is_overdue: scheduleDueAt < easternToday(),
  },
};
const schedule = {
  id: "schedule-example",
  task_name: "Synthetic inspection",
  interval_miles: 5000,
  interval_months: 6,
  next_due_at: scheduleDueAt,
  priority: "normal",
  estimated_cost: 100,
  is_overdue: scheduleDueAt < easternToday(),
  equipment_name: equipment.name,
  category: "vehicle",
  asset_tag: "QA-001",
};
const record = {
  id: "record-example",
  task_name: "Synthetic oil change",
  maintenance_type: "scheduled",
  performed_by: "Fixture operator",
  performed_at: maintenanceAt,
  total_cost: 100,
};
// The real costOfOwnership divides total_cost by the SUM of this vehicle's
// mileage logs (server/services/equipment-maintenance.js), so the cost metrics
// below and these logs have to be the same number or the Cost/Mile tile the
// fixture is meant to exercise renders from a figure production never produced.
const vehicleTotalMiles = 100;
const round2 = (value) => Math.round(value * 100) / 100;
const mileage = {
  logs: [
    {
      id: "mileage-example",
      log_date: mileageLogDate,
      odometer_start: 11900,
      odometer_end: 11900 + vehicleTotalMiles,
      total_miles: vehicleTotalMiles,
      business_miles: 90,
      personal_miles: 10,
      business_pct: 90,
      fuel_gallons: 5,
      fuel_cost: 20,
      jobs_serviced: 3,
      irs_deduction_amount: 63,
      source: "manual",
    },
  ],
};
const maintenanceSpend = 100;
// The vehicle's mileage rows are the one source for every derived figure the
// detail and analytics screens show: costOfOwnership sums vehicle_mileage_log
// for miles and fuel, and the mileage endpoint aggregates the same rows
// independently of the list limit (server/services/equipment-maintenance.js).
// Deriving both from whichever rows are being served keeps the long
// sticky-header set from contradicting the summary and cost tiles rendered
// beside it.
// One aggregate over the rows, shaped per endpoint. The fleet route sums the
// same columns the detail summary does (routes/admin-equipment-maintenance.js
// and services/equipment-maintenance.js), so a single source here is what keeps
// the long sticky-header set from contradicting the tiles beside it.
function sumMileage(logs) {
  const sum = (field) => logs.reduce((total, log) => total + log[field], 0);
  return {
    total_miles: sum("total_miles"),
    business_miles: sum("business_miles"),
    personal_miles: sum("personal_miles"),
    total_fuel_cost: round2(sum("fuel_cost")),
    total_fuel_gallons: round2(sum("fuel_gallons")),
    total_irs_deduction: round2(sum("irs_deduction_amount")),
    total_jobs: sum("jobs_serviced"),
  };
}
function summarizeMileage(logs) {
  const totals = sumMileage(logs);
  return {
    total_miles: totals.total_miles,
    business_miles: totals.business_miles,
    total_fuel_cost: totals.total_fuel_cost,
    total_irs_deduction: totals.total_irs_deduction,
    avg_mpg:
      totals.total_fuel_gallons > 0
        ? round2(totals.total_miles / totals.total_fuel_gallons)
        : null,
  };
}
const inYear = (date, year) => date.slice(0, 4) === String(year);
// getFleetOverview() sums the same rows, so the long sticky-header set has to
// move these YTD figures with it — navigating back to Maintenance re-fetches
// this endpoint while those rows are installed. It is a year-to-date figure:
// the query starts at the year boundary, so rows the long set walks back past
// it are excluded here even though the detail summary and costOfOwnership,
// which have no year filter, still count them.
function fleetOverview(logs, assets = 1) {
  const year = easternYear(),
    totals = sumMileage(logs.filter((log) => inYear(log.log_date, year)));
  return {
    total_assets: assets,
    overdue_maintenance: 0,
    ytd_maintenance_spend:
      assets && inYear(maintenanceAt, year) ? maintenanceSpend : 0,
    ytd_total_miles: totals.total_miles,
    ytd_fuel_cost: totals.total_fuel_cost,
    ytd_irs_deduction: totals.total_irs_deduction,
  };
}
// The real list routes apply the requested limit while their aggregates are
// computed over every row, so the fixture has to do both — otherwise a page
// that quietly halved its limit would still look like it rendered the full set,
// and the sticky-header scroll check would pass on rows production would not
// have sent.
function limited(url, rows) {
  const limit = Number(url.searchParams.get("limit"));
  return Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}
// The age is a live month difference from purchase_date and the total is
// divided by it, so a pinned age_months/monthly_cost pair stops being a
// response production can return the moment the month rolls over — 32/$785
// today, 33/$761.21 from October. The year and month are parsed off the date
// string rather than through Date, whose UTC midnight reads back as the
// previous December in this runner's zone.
function ownership(logs) {
  const [purchaseYear, purchaseMonth] = equipment.purchase_date
    .split("-")
    .map(Number);
  const now = new Date();
  const ageMonths = Math.max(
    1,
    (now.getFullYear() - purchaseYear) * 12 +
      (now.getMonth() - (purchaseMonth - 1)),
  );
  const sum = (field) => logs.reduce((total, log) => total + log[field], 0);
  const totalMiles = sum("total_miles"),
    totalFuel = round2(sum("fuel_cost")),
    totalMaintenance = maintenanceSpend,
    purchasePrice = 25000,
    totalCost = round2(purchasePrice + totalMaintenance + totalFuel);
  return {
    equipment_id: id,
    equipment_name: equipment.name,
    category: "vehicle",
    asset_tag: "QA-001",
    age_months: ageMonths,
    purchase_price: purchasePrice,
    total_maintenance: totalMaintenance,
    total_fuel: totalFuel,
    total_cost: totalCost,
    monthly_cost: round2(totalCost / ageMonths),
    cost_per_mile: totalMiles > 0 ? round2(totalCost / totalMiles) : null,
    total_miles: totalMiles,
    condition_rating: 8,
    total_irs_deduction: round2(sum("irs_deduction_amount")),
  };
}
// Matches the job-cost summary below (1 pest job, $250 revenue, $100 cost,
// 60% margin) so the list and the summary cannot disagree — the real
// endpoints read the same `job_costs` table and never do.
const jobCost = {
  id: "job-cost-example",
  service_record_id: null,
  customer_id: "customer-example",
  customer_name: "Fixture Customer",
  service_date: jobServiceDate,
  service_type: "pest",
  products_cost: 40,
  labor_cost: 45,
  drive_cost: 10,
  equipment_cost: 5,
  total_cost: 100,
  revenue: 250,
  gross_profit: 150,
  margin_pct: 60,
  tank_mix_id: null,
  sqft_treated: 2500,
  products_used: [],
};
const calibration = {
  id: calibrationId,
  carrier_gal_per_1000: 2,
  calibration_status: "estimated_not_field_verified",
  expires_at: calibrationExpiresAt,
};
const system = {
  id: systemId,
  name: "Example spray rig",
  system_type: "truck_sprayer",
  tank_capacity_gal: 100,
  active: true,
  linked_equipment_ids: [id],
  active_linked_equipment_ids: [id],
  primary_equipment: equipment,
  component_assets: [],
};
const taxRegisterAsset = {
  id: "tax-asset-example",
  name: equipment.name,
  asset_category: "vehicle",
  active: true,
  disposed: false,
  purchase_cost: equipment.purchase_price,
  current_book_value: equipment.book_value,
  serial_number: equipment.serial_number,
  make_model: `${equipment.make} ${equipment.model}`,
};
// The real endpoint answers a request that carries no `year` with the current
// Eastern year (server/routes/admin-equipment-maintenance.js). Pinning a
// literal here would keep rendering "Fleet Mileage Summary (2026)" from January
// onward, against a response shape production could no longer return for that
// request.
// install()'s route key is `${method} ${pathname}`, so a request whose query
// changed still matches its fixture and still receives the happy-path body.
// These are the query values each of those responses is only truthful for: an
// alerts view that started asking for `status=all`, or a list that dropped or
// mangled its `limit`, is asking production a different question than the
// fixture answers, and the real endpoint would return other rows or reject the
// parse outright.
function limitParam(query) {
  const raw = query.get("limit");
  return raw !== null && /^[1-9][0-9]*$/.test(raw) ? null : `limit=${raw}`;
}
function queryContracts() {
  return new Map([
    [
      "GET /api/admin/equipment-maintenance/alerts",
      (query) =>
        query.get("status") === "new" ? null : `status=${query.get("status")}`,
    ],
    ["GET /api/admin/equipment-maintenance/records/recent", limitParam],
    [`GET /api/admin/equipment-maintenance/${id}/mileage`, limitParam],
    ["GET /api/admin/equipment/job-costs", limitParam],
  ]);
}
function fixtures(state) {
  const activeMileage = () => state.mileageLogs || mileage.logs;
  return new Map([
    [
      "GET /api/admin/auth/me",
      () => ({
        id: "fixture-admin",
        role: state.role || "admin",
        name: "Fixture operator",
      }),
    ],
    ["GET /api/admin/feature-flags", () => ({ flags: {} })],
    ["GET /api/admin/notifications/unread-count", () => ({ count: 0 })],
    [
      "GET /api/admin/communications/unread-count",
      () => ({ count: 0, conversations: 0 }),
    ],
    ["POST /api/admin/usage/track", () => ({ ok: true })],
    ["POST /api/client-errors", () => ({ ok: true })],
    [
      "GET /api/admin/equipment/equipment",
      () => ({
        equipment: state.empty
          ? []
          : [{ ...equipment, name: state.assetName || equipment.name }],
      }),
    ],
    ["POST /api/admin/equipment/equipment", () => ({ equipment })],
    [`PUT /api/admin/equipment/equipment/${id}`, () => ({ equipment })],
    [
      "GET /api/admin/equipment/tank-mixes",
      () => ({
        tank_mixes: state.empty
          ? []
          : [
              {
                id: "mix-example",
                name: "Synthetic tank mix",
                service_type: "pest",
                tank_size_gal: 100,
                coverage_sqft: 50000,
                cost_per_tank: 50,
                cost_per_1000sf: 1,
                products: [
                  {
                    product_name: "Synthetic material",
                    rate_per_1000sf: 1,
                    rate_unit: "oz",
                    oz_per_tank: 50,
                    cost: 50,
                  },
                ],
              },
            ],
      }),
    ],
    [
      "POST /api/admin/equipment/tank-mixes/mix-example/recalculate",
      () => ({ ok: true }),
    ],
    [
      "GET /api/admin/equipment/job-costs/summary",
      () =>
        // An empty job_costs table does not come back null: the route
        // normalizes the null aggregate to 0 and derives the averages from a
        // zero job count (server/routes/admin-equipment.js), so the tiles read
        // "0.0%" rather than an em dash.
        (state.empty
          ? {
              avgMargin: 0,
              avgRevenue: 0,
              avgCost: 0,
              totalJobs: 0,
              byServiceType: {},
            }
          : state.jobSummary) || {
          avgMargin: 60,
          avgRevenue: 250,
          avgCost: 100,
          totalJobs: 1,
          byServiceType: {
            pest: { count: 1, avgRevenue: 250, avgCost: 100, avgMargin: 60 },
          },
        },
    ],
    [
      "GET /api/admin/equipment/job-costs",
      (url) => {
        const rows = state.empty ? [] : [jobCost];
        return {
          job_costs: limited(url, rows),
          costs: limited(url, rows),
          total: rows.length,
          page: 1,
        };
      },
    ],
    [
      "GET /api/admin/equipment-maintenance",
      () => ({ equipment: state.empty ? [] : [equipment] }),
    ],
    [
      "GET /api/admin/equipment-maintenance/analytics/overview",
      () => (state.empty ? fleetOverview([], 0) : fleetOverview(activeMileage())),
    ],
    [
      "GET /api/admin/equipment-maintenance/alerts",
      () => ({
        alerts: state.empty
          ? []
          : [
              {
                id: "alert-example",
                severity: "medium",
                title: "Synthetic maintenance review",
              },
            ],
      }),
    ],
    [
      "PUT /api/admin/equipment-maintenance/alerts/alert-example",
      () => ({ ok: true }),
    ],
    [
      `GET /api/admin/equipment-maintenance/${id}`,
      () => ({
        equipment,
        schedules: [schedule],
        recentRecords: [record],
        costOfOwnership: ownership(activeMileage()),
      }),
    ],
    [
      `GET /api/admin/equipment-maintenance/${id}/mileage`,
      (url) => {
        const logs = activeMileage();
        return { logs: limited(url, logs), summary: summarizeMileage(logs) };
      },
    ],
    [
      `POST /api/admin/equipment-maintenance/${id}/mileage`,
      () => ({ ok: true }),
    ],
    [
      `POST /api/admin/equipment-maintenance/${id}/records`,
      () => ({ ok: true }),
    ],
    [
      "GET /api/admin/equipment-maintenance/analytics/costs",
      () => ({ costs: state.empty ? [] : [ownership(activeMileage())] }),
    ],
    [
      "GET /api/admin/equipment-maintenance/analytics/reliability",
      () => ({
        reliability: state.empty
          ? []
          : [
              {
                id,
                name: equipment.name,
                category: "vehicle",
                asset_tag: "QA-001",
                incident_count: 1,
                total_downtime_hours: 2,
                total_jobs_affected: 0,
                total_revenue_impact: 0,
              },
            ],
      }),
    ],
    [
      "GET /api/admin/equipment-maintenance/mileage/summary",
      (url) => {
        // The route filters log_date to the requested year and groups by
        // equipment, so a vehicle with no rows in that year is absent entirely
        // rather than present with zeroes.
        const year = Number(url.searchParams.get("year")) || easternYear(),
          rows = (state.empty ? [] : activeMileage()).filter((log) =>
            inYear(log.log_date, year),
          ),
          totals = sumMileage(rows);
        return {
          year,
          vehicles: rows.length
            ? [{ id, name: equipment.name, asset_tag: "QA-001", ...totals }]
            : [],
          fleet_totals: totals,
        };
      },
    ],
    [
      "GET /api/admin/equipment-maintenance/schedules/due",
      () => ({ schedules: state.empty ? [] : [schedule] }),
    ],
    [
      "GET /api/admin/equipment-maintenance/records/recent",
      (url) => ({ records: limited(url, state.empty ? [] : [record]) }),
    ],
    [
      "GET /api/admin/equipment-systems",
      () => ({ systems: state.empty ? [] : [system] }),
    ],
    [
      "GET /api/admin/equipment-systems/reconciliation",
      () => ({
        systems: state.empty ? [] : [system],
        equipment: state.empty
          ? []
          : [{ ...equipment, tax_register: taxRegisterAsset }],
        issues: [],
        summary: {
          systems_with_any_equipment_link: state.empty ? 0 : 1,
          systems_active: state.empty ? 0 : 1,
          systems_without_equipment_link: 0,
          equipment_with_tax_link: state.empty ? 0 : 1,
          equipment_active: state.empty ? 0 : 1,
          tax_register_unlinked: 0,
        },
      }),
    ],
    [
      `GET /api/admin/equipment-systems/${systemId}`,
      () => ({ system, calibration }),
    ],
    [
      `POST /api/admin/equipment-systems/${systemId}/calibrations`,
      () => ({ calibration }),
    ],
    [
      `POST /api/admin/equipment-systems/calibrations/${calibrationId}/verify`,
      () => ({
        calibration: { ...calibration, calibration_status: "field_verified" },
      }),
    ],
  ]);
}
const requestKey = (request) =>
  `${request.method()} ${new URL(request.url()).pathname}`;
async function install(page, server, state) {
  const handlers = fixtures(state),
    contracts = queryContracts();
  state.fixtureGets = [...handlers.keys()].filter((key) =>
    key.startsWith("GET "),
  );
  await page.addInitScript(() => {
    // Toasts live for 3.5s and a second toast can be cleared early by the
    // first one's timer, so record every status render instead of racing it.
    window.__toasts = [];
    const record = (node, type) => {
      if (!node || node.nodeType !== 1) return;
      const found = node.matches?.('[role="status"]') ? [node] : [];
      node.querySelectorAll?.('[role="status"]').forEach((n) => found.push(n));
      for (const el of found) {
        const text = (el.textContent || "").trim();
        if (text) window.__toasts.push({ text, type, at: Date.now() });
      }
    };
    const observe = () =>
      new MutationObserver((records) => {
        for (const entry of records) {
          entry.addedNodes.forEach((n) => record(n, "shown"));
          entry.removedNodes.forEach((n) => record(n, "removed"));
          if (entry.type === "characterData")
            record(entry.target.parentElement, "shown");
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    if (document.documentElement) observe();
    else document.addEventListener("DOMContentLoaded", observe);
    localStorage.setItem("waves_admin_token", "synthetic-token");
    // Chromium can let keepalive fetches outlive Playwright interception.
    // Drop synthetic auth before the app's pagehide usage-beacon listener.
    window.addEventListener(
      "pagehide",
      () => localStorage.removeItem("waves_admin_token"),
      { capture: true },
    );
    window.addEventListener("pageshow", () =>
      localStorage.setItem("waves_admin_token", "synthetic-token"),
    );
    localStorage.setItem(
      "waves_admin_user",
      JSON.stringify({
        id: "fixture-admin",
        role: "admin",
        name: "Fixture operator",
      }),
    );
    if (navigator.serviceWorker)
      navigator.serviceWorker.register = async () => ({
        scope: "synthetic",
      });
  });
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (m) => {
    if (m.type() === "error")
      state.consoleErrors.push({
        text: m.text(),
        url: m.location().url,
      });
  });
  // None of these views expects a native alert, confirm or prompt. Accepting
  // silently meant a regression that threw one up would be dismissed before the
  // screenshots and assertions ran, and the view-only pass would still report
  // success. Accept so the page cannot hang, but record it as a failure.
  page.on("dialog", (dialog) => {
    state.dialogs.push({ type: dialog.type(), message: dialog.message() });
    return dialog.accept(dialog.type() === "prompt" ? "80" : undefined);
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== server.baseUrl || url.pathname.startsWith("/socket.io"))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {}
    state.requests.push({
      key,
      query: url.search,
      body,
    });
    // The query contract is checked before the injection branches below, so a
    // request that is about to be held or failed is still judged on what it
    // asked for.
    const contract = contracts.get(key);
    if (contract) {
      const violation = contract(url.searchParams);
      if (violation) state.badQuery.push(`${key} (${violation})`);
    }
    if (state.hold?.key === key) await state.hold.promise;
    if (state.failures.has(key)) {
      if (request.method() !== "GET") state.failures.delete(key);
      state.expectedFailures.push(url.href);
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Synthetic request failed. Try again.",
        }),
      });
    }
    if (!handlers.has(key)) {
      state.unmatched.push(key);
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Unmatched synthetic fixture"}',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(handlers.get(key)(url, body)),
    });
  });
}
async function shot(page, report, name, target) {
  if (target) {
    await target.evaluate((node) => node.scrollIntoView({
      block: "center", inline: "nearest", behavior: "instant",
    }));
  } else {
    await page.evaluate(() => {
      document.scrollingElement.scrollTop = 0;
      const main = document.querySelector("main");
      if (main) main.scrollTop = 0;
    });
  }
  await page.waitForTimeout(400);
  if (target) {
    const box = await target.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height,
      name + ": screenshot target is inside the viewport");
  }
  const file = path.join(output, `${name}.png`);
  const fullPage = !target && (await page.getByRole("dialog").count()) === 0;
  // #admin-main owns this page's vertical scrolling (AdminLayoutV2), so the
  // document stays viewport-height and Playwright's fullPage — which expands
  // the document, not an arbitrary nested scroller — would capture only the
  // visible slice of a long leaf. Releasing the scroller alone is not enough:
  // .admin-shell-v2 above it is a fixed-height overflow:hidden box that clamps
  // the document right back. Free the whole chain up to the body for the
  // capture, then restore each element's own inline style. Descendants are
  // untouched, so the intentional table and chart scrollers still clip.
  const released = fullPage
    ? await page.evaluate(() => {
        const main = document.getElementById("admin-main");
        if (!main) return 0;
        let count = 0;
        for (
          let node = main;
          node && node !== document.body;
          node = node.parentElement
        ) {
          node.dataset.qaPreviousStyle = node.style.cssText;
          node.style.height = "auto";
          node.style.minHeight = "0";
          node.style.maxHeight = "none";
          node.style.overflow = "visible";
          count += 1;
        }
        return count;
      })
    : 0;
  if (released) await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage });
  if (released)
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("[data-qa-previous-style]")) {
        node.style.cssText = node.dataset.qaPreviousStyle;
        delete node.dataset.qaPreviousStyle;
      }
    });
  report.screenshots.push(path.relative(root, file));
}
async function geometry(page, state, surface) {
  const data = await page.evaluate(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector("main .ui-surface");
    if (!root) throw Error("Surface missing");
    const visible = (n) =>
      n.getClientRects().length > 0 && !n.closest("[hidden],[inert]");
    const inScrollable = (n) => !!n.closest(".ui-table,.ui-workspace-nav");
    const controls = [
      ...root.querySelectorAll(
        'button,input:not([type="checkbox"]):not([type="file"]),select,textarea,a',
      ),
    ]
      .filter(visible)
      .map((n) => {
        const r = n.getBoundingClientRect(),
          s = getComputedStyle(n);
        return {
          name:
            n.getAttribute("aria-label") ||
            n.labels?.[0]?.textContent ||
            n.textContent.trim(),
          height: r.height,
          width: r.width,
          left: r.left,
          right: r.right,
          font: parseFloat(s.fontSize),
          field: ["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName),
          scrollable: inScrollable(n),
          labeled:
            !["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName) ||
            [...(n.labels || [])].some((l) => l.textContent.trim()) ||
            !!n.getAttribute("aria-label"),
        };
      });
    const smallText = [...root.querySelectorAll("*")]
      .filter(visible)
      .filter((n) =>
        [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()),
      )
      .filter((n) => {
        const scale =
          n.tagName.toLowerCase() === "text" ? n.getScreenCTM() : null;
        return (
          parseFloat(getComputedStyle(n).fontSize) *
            (scale ? Math.hypot(scale.a, scale.b) : 1) <
          13.99
        );
      })
      .map((n) => n.textContent.slice(0, 80));
    const narrowCells = [...root.querySelectorAll("tbody td")]
      .filter(visible)
      .filter((n) =>
        /^\$[\d,.]+$|^\d{1,2}\/\d{1,2}\/\d{4}$/.test(n.textContent.trim()),
      )
      .filter((n) => {
        const text = [...n.childNodes].find(
          (child) => child.nodeType === 3 && child.textContent.trim(),
        );
        if (!text) return false;
        const range = document.createRange();
        range.selectNodeContents(text);
        return range.getClientRects().length > 1;
      })
      .map((n) => n.textContent.trim());
    // The 44px target for a checkbox or radio comes from its .ui-choice-label
    // wrapper (ui-workspace.css), never from the 16px input, and the controls
    // sweep above deliberately excludes checkbox inputs — so without this the
    // Record Maintenance choices have no size or labelling check at all.
    const choices = [...root.querySelectorAll(".ui-choice-label")]
      .filter(visible)
      .map((n) => {
        const r = n.getBoundingClientRect(),
          box = n.querySelector(
            'input[type="checkbox"],input[type="radio"]',
          );
        return {
          name: n.textContent.trim(),
          height: r.height,
          width: r.width,
          left: r.left,
          right: r.right,
          labeled:
            !!box && [...(box.labels || [])].some((l) => l.textContent.trim()),
        };
      });
    // Every width here scrolls inside the fixed-height #admin-main
    // (AdminLayoutV2), so content that widens that element is contained by it
    // and never reaches documentElement.scrollWidth — a regression that adds a
    // page-level horizontal scrollbar is invisible to the check below.
    const adminMain = document.getElementById("admin-main");
    return {
      controls,
      choices,
      smallText,
      narrowCells,
      mainScroller: !!adminMain,
      mainOverflow:
        !!adminMain && adminMain.scrollWidth > adminMain.clientWidth + 1,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      title: parseFloat(
        getComputedStyle(document.querySelector("main h1")).fontSize,
      ),
    };
  });
  state.geometry.push({
    surface,
    viewport: page.viewportSize(),
    ...data,
  });
  assert.equal(data.overflow, false, `${surface}: document overflow`);
  // Without this the check above reports "no overflow" for a layout that no
  // longer has the scroller at all, which is exactly the silent pass it exists
  // to close.
  assert.equal(data.mainScroller, true, `${surface}: admin main is present`);
  assert.equal(data.mainOverflow, false, `${surface}: admin main overflow`);
  assert.deepEqual(data.smallText, [], `${surface}: small text`);
  assert.deepEqual(
    data.narrowCells,
    [],
    `${surface}: wrapped money or date cells`,
  );
  assert.equal(data.title, 22, `${surface}: title`);
  for (const c of data.controls) {
    assert.ok(c.height >= 43.5, `${surface}: height ${JSON.stringify(c)}`);
    assert.ok(c.font >= 14, `${surface}: font ${JSON.stringify(c)}`);
    if (c.field)
      assert.ok(c.font >= 16, `${surface}: field text ${JSON.stringify(c)}`);
    assert.ok(c.labeled, `${surface}: label ${JSON.stringify(c)}`);
    if (!c.scrollable)
      assert.ok(
        c.left >= -1 && c.right <= page.viewportSize().width + 1,
        `${surface}: bounds ${JSON.stringify(c)}`,
      );
  }
  for (const c of data.choices) {
    assert.ok(
      c.height >= 43.5,
      `${surface}: choice height ${JSON.stringify(c)}`,
    );
    assert.ok(c.labeled, `${surface}: choice label ${JSON.stringify(c)}`);
    assert.ok(
      c.left >= -1 && c.right <= page.viewportSize().width + 1,
      `${surface}: choice bounds ${JSON.stringify(c)}`,
    );
  }
}
async function widths(page, state, surface) {
  const original = page.viewportSize();
  for (const viewport of [
    {
      width: 390,
      height: 844,
    },
    {
      width: 700,
      height: 1000,
    },
    {
      width: 820,
      height: 1000,
    },
    {
      width: 1024,
      height: 1000,
    },
    {
      width: 1440,
      height: 1000,
    },
    {
      width: 844,
      height: 390,
    },
    {
      width: 390,
      height: 420,
    },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await geometry(page, state, surface);
  }
  await page.setViewportSize(original);
}
async function retryWrite(page, state, key, button, verify, pending) {
  const before = state.requests.filter((r) => r.key === key).length;
  const original = await button.boundingBox();
  state.failures.add(key);
  let release;
  state.hold = {
    key,
    promise: new Promise((r) => {
      release = r;
    }),
  };
  state.hold.release = release;
  await button.evaluate((n) => {
    n.click();
    n.click();
  });
  await button.and(page.locator('[aria-busy="true"]')).waitFor();
  assert.equal(await button.isDisabled(), true, key + " disabled while saving");
  const held = await button.boundingBox();
  assert.ok(
    Math.abs(original.width - held.width) < 1 &&
      Math.abs(original.height - held.height) < 1,
    key + " stable pending button",
  );
  if (pending) await pending();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    state.requests.filter((r) => r.key === key).length,
    before + 1,
    key + " single pending write",
  );
  release();
  state.hold = null;
  await page
    .getByRole("alert")
    .filter({
      hasText: /Synthetic request failed|HTTP 503/,
    })
    .waitFor();
  if (verify) await verify();
  const first = state.requests.filter((r) => r.key === key).at(-1).body;
  await button.click();
  await page.waitForTimeout(250);
  assert.equal(
    state.requests.filter((r) => r.key === key).length,
    before + 2,
    key + " retry",
  );
  assert.deepEqual(
    state.requests.filter((r) => r.key === key).at(-1).body,
    first,
    key + " preserved payload",
  );
  state.checks.push(
    key + " pending, failed draft, retry and preserved payload",
  );
  console.log(key + " retry passed");
  return first;
}
function gallery(report) {
  const files = report.screenshots.map((f) => path.basename(f));
  const keys = [
    ...new Set(
      files.map((f) =>
        f.replace(/^(desktop|touch-webkit)-/, "").replace(/\.png$/, ""),
      ),
    ),
  ];
  fs.writeFileSync(
    path.join(output, "review.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Equipment review</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.5 system-ui}main{max-width:1440px;margin:auto;padding:28px}h2{text-transform:capitalize}section{margin:40px 0}.pair{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,1fr);gap:20px}img{width:100%;border:1px solid #d4d4d8}figure{margin:0}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><main><h1>Equipment review</h1><p>Synthetic records · ${report.sha.slice(0, 12)} · ${report.dirty ? "working tree" : "clean commit"}</p>${keys
      .map(
        (k) =>
          `<section><h2>${k.replaceAll("-", " ")}</h2><div class="pair">${[
            "desktop",
            "touch-webkit",
          ]
            .filter((d) => files.includes(`${d}-${k}.png`))
            .map(
              (d) =>
                `<figure><figcaption>${d}</figcaption><a href="${d}-${k}.png"><img loading="lazy" src="${d}-${k}.png" alt="${k}"></a></figure>`,
            )
            .join("")}</div></section>`,
      )
      .join("")}</main></html>`,
  );
}
async function section(page, group, leaf, expected) {
  await page
    .getByRole("navigation", { name: "Equipment section", exact: true })
    .getByRole("button", { name: group, exact: true })
    .click();
  if (leaf)
    await page
      .locator("main")
      .getByRole("tab", { name: leaf, exact: true })
      .click();
  // EquipmentPage writes the rendered leaf into ?tab= (assets clears it), so
  // the URL is the authoritative "which leaf mounted" signal. Without this a
  // parent click that silently stops moving the leaf would leave the previous
  // view mounted and every later check — screenshot, widths, NaN — would pass
  // against the wrong screen under the next leaf's name.
  await page.waitForFunction(
    (want) =>
      (new URL(window.location.href).searchParams.get("tab") || "assets") ===
      want,
    expected,
    { timeout: 5000 },
  );
  await page.waitForTimeout(200);
}
async function fleetDetail(page) {
  await page
    .getByRole("button", { name: new RegExp("^Expand .*" + equipment.name) })
    .click();
  await page
    .getByRole("button", { name: "Record Maintenance", exact: true })
    .waitFor();
}
async function capture(page, state, report, device, key, target) {
  await widths(page, state, key);
  await shot(page, report, device + "-" + key, target);
}
async function mileageHeader(page, server, state, report, device) {
  // vehicle_mileage_log is unique on (vehicle_id, log_date), so 30 rows sharing
  // one date is a state the real endpoint cannot return — and the summary and
  // cost tiles beside the list aggregate every row, so they move with it.
  state.mileageLogs = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(`${mileage.logs[0].log_date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - index);
    return {
      ...mileage.logs[0],
      id: `mileage-example-${index}`,
      log_date: day.toISOString().slice(0, 10),
      odometer_start:
        mileage.logs[0].odometer_start - index * vehicleTotalMiles,
      odometer_end: mileage.logs[0].odometer_end - index * vehicleTotalMiles,
    };
  });
  try {
    await page.goto(server.baseUrl + "/admin/equipment?tab=maintenance");
    await fleetDetail(page);
    const table = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Biz %", exact: true }),
    });
    await table.getByRole("columnheader", { name: "Date", exact: true }).scrollIntoViewIfNeeded();
    const position = await table.evaluate(async (node) => {
      let scroller = node.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error("Mileage log has no vertical scroller");
      scroller.scrollTop = 0;
      const header = node.querySelector("thead tr");
      const row = node.querySelector("tbody tr");
      const before = { header: header.getBoundingClientRect().top, row: row.getBoundingClientRect().top };
      scroller.scrollTop = 180;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { before, header: header.getBoundingClientRect().top, row: row.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
    });
    assert.ok(position.scrollTop >= 170, "Mileage log scrolls vertically");
    assert.ok(Math.abs(position.header - position.before.header) < 2, "Mileage header stays visible while scrolling");
    assert.ok(position.row < position.before.row - 100, "Mileage rows scroll beneath their header");
    state.checks.push("Mileage header remains sticky while a long log scrolls");
    const file = path.join(output, `${device}-mileage-sticky-header.png`);
    await page.screenshot({ path: file });
    report.screenshots.push(path.relative(root, file));
  } finally {
    state.mileageLogs = null;
  }
}
async function views(page, server, state, report, device) {
  await page.goto(server.baseUrl + "/admin/equipment?source=synthetic");
  await page.getByText(equipment.name, { exact: true }).waitFor();
  await waitForFonts(page);
  for (const [group, leaf, key] of [
    ["Assets", null, "assets"],
    ["Maintenance", null, "maintenance"],
    ["Maintenance", "Calibrations", "calibrations"],
    ["Tank Mixes", null, "tank-mixes"],
    ["Costs", null, "job-costs"],
    ["Costs", "Analytics", "analytics"],
  ]) {
    await section(page, group, leaf, key);
    await capture(page, state, report, device, key);
    // A fixture that omits a field the real endpoint always returns renders it
    // literally — `NaN` through a Number(), `undefined` when interpolated raw —
    // and the screenshot captures that malformed state while the run passes.
    const rendered = await page.locator("main").innerText();
    const malformed = rendered.match(/\b(?:NaN|undefined)\b/);
    assert.ok(
      !malformed,
      `${key} view renders without NaN/undefined (found "${malformed?.[0]}")`,
    );
    if (key === "analytics") {
      const fleetTotalsRow = page.getByRole("row", { name: /Fleet Totals/ });
      assert.equal(await fleetTotalsRow.count(), 1, "Fleet totals row is rendered");
      const cells = await fleetTotalsRow.locator("td").allInnerTexts();
      assert.ok(
        cells.every((cell) => cell.trim().length > 0),
        "Fleet totals row has no blank cells",
      );
    }
    console.log(device + ": " + key);
  }
  const chart = page.getByRole("region", { name: "Monthly maintenance costs chart", exact: true });
  // Setting scrollLeft proves nothing on its own: a chart that became clipped
  // or non-scrollable would still take an ordinary screenshot and the run would
  // report success while quietly losing the scrolled-chart evidence.
  const scrolled = await chart.evaluate((node) => {
    node.scrollLeft = node.scrollWidth - node.clientWidth;
    return {
      overflow: node.scrollWidth - node.clientWidth,
      scrollLeft: node.scrollLeft,
    };
  });
  // The chart has a fixed minimum width, so it overflows on the phone column
  // and fits on the desktop one. Pinning that per device makes both directions
  // falsifiable: a desktop chart that started overflowing is a regression, and
  // so is a phone chart that stopped scrolling — which is what the
  // "analytics-chart" capture claims to show.
  const mustScroll = device === "touch-webkit";
  assert.equal(
    scrolled.overflow > 0,
    mustScroll,
    `${device} chart overflow: ${JSON.stringify(scrolled)}`,
  );
  if (mustScroll)
    assert.ok(
      Math.abs(scrolled.scrollLeft - scrolled.overflow) <= 1,
      `Chart reaches its end position: ${JSON.stringify(scrolled)}`,
    );
  state.checks.push(
    mustScroll
      ? "Monthly cost chart scrolls to its end position on the phone column"
      : "Monthly cost chart fits the desktop column without scrolling",
  );
  await shot(page, report, device + "-analytics-chart", chart);
  await section(page, "Assets", null, "assets");
  for (const [label, key] of [
    ["Add Equipment", "new-equipment"],
    ["Edit", "edit-equipment"],
  ]) {
    const opener = page.getByRole("button", { name: label, exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await capture(page, state, report, device, key);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await opener.evaluate((n) => document.activeElement === n),
      true,
      "Opener focus returns",
    );
  }
  await section(page, "Maintenance", null, "maintenance");
  await fleetDetail(page);
  // costOfOwnership always returns cost_per_mile for a vehicle that has mileage
  // logs, and the detail renders that tile conditionally — without this the
  // fixture could drop the metric again and every screenshot would still pass.
  await page.getByText("Cost/Mile", { exact: true }).waitFor();
  state.checks.push("Expanded detail renders the Cost/Mile tile");
  await capture(page, state, report, device, "maintenance-detail",
    page.getByRole("button", { name: "Record Maintenance", exact: true }));
  for (const [label, key] of [
    ["Record Maintenance", "record-maintenance"],
    ["Log Mileage", "log-mileage"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await capture(page, state, report, device, key,
      page.getByRole("heading", { name: label, exact: true }));
    if (label === "Record Maintenance") {
      // Record Maintenance is the only surface in this runner with choice
      // controls, so without this pin the geometry sweep's choice checks would
      // pass on every screen by measuring nothing at all.
      const measured = state.geometry
        .filter((entry) => entry.surface === key)
        .map((entry) => entry.choices.map((choice) => choice.name));
      assert.ok(
        measured.length > 0 &&
          measured.every(
            (names) =>
              names.includes("Follow-up needed") &&
              names.includes("Warranty claim"),
          ),
        `Record Maintenance choice targets measured: ${JSON.stringify(measured)}`,
      );
      state.checks.push(
        "Follow-up needed and Warranty claim meet the choice target size at every width",
      );
    }
    await shot(page, report, device + "-" + key + "-actions",
      page.getByRole("button", { name: label === "Record Maintenance" ? "Save Record" : "Save Mileage", exact: true }));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await section(page, "Maintenance", "Calibrations", "calibrations");
  await page
    .getByLabel("Equipment system", { exact: true })
    .selectOption(systemId);
  await page.getByText("Current active calibration", { exact: true }).waitFor();
  await capture(page, state, report, device, "selected-calibration",
    page.getByLabel("Test area (sqft)", { exact: true }));
  await shot(page, report, device + "-selected-calibration-actions",
    page.getByRole("button", { name: "Save Calibration (expires in 30 days)", exact: true }));
  await page
    .getByRole("button", { name: "Verify Calibration", exact: true })
    .click();
  await capture(page, state, report, device, "verify-calibration",
    page.getByLabel("Measured sqft", { exact: true }));
  await shot(page, report, device + "-verify-calibration-actions",
    page.getByRole("button", { name: "Mark Field Verified", exact: true }));
  await mileageHeader(page, server, state, report, device);
}
async function toast(page, text) {
  await page.waitForFunction(
    (expected) =>
      (window.__toasts || []).some(
        (entry) => entry.type === "shown" && entry.text.includes(expected),
      ),
    text,
    { timeout: 15000 },
  );
}
async function fillFields(page, fields) {
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value);
}
async function writes(page, server, state, report, device) {
  await page.goto(server.baseUrl + "/admin/equipment?source=synthetic");
  await page.getByText(equipment.name, { exact: true }).waitFor();
  assert.equal(
    await page.locator("main").getByText("toast &&", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator("main").getByRole("status").count(),
    0,
    "No empty toast",
  );
  await page
    .getByRole("button", { name: "Add Equipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Name is required" })
    .waitFor();
  assert.equal(
    state.requests.filter(
      (r) => r.key === "POST /api/admin/equipment/equipment",
    ).length,
    0,
  );
  await fillFields(page, {
    "Name *": "Example spare sprayer",
    "Purchase Price ($)": "1250.50",
    "Current Hours": "0",
    Notes: "Synthetic asset draft",
  });
  const created = await retryWrite(
    page,
    state,
    "POST /api/admin/equipment/equipment",
    dialog.getByRole("button", { name: "Save", exact: true }),
    async () => {
      assert.equal(
        await page.getByLabel("Name *", { exact: true }).inputValue(),
        "Example spare sprayer",
      );
      await shot(page, report, device + "-failed-equipment-save");
    },
    async () => {
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), true, "Pending dialog stays open");
      assert.equal(
        await dialog
          .locator("input,select,textarea")
          .evaluateAll((nodes) => nodes.every((n) => n.disabled)),
        true,
      );
    },
  );
  assert.deepEqual(created, {
    name: "Example spare sprayer",
    category: "other",
    make: "",
    model: "",
    serial_number: "",
    purchase_date: null,
    purchase_price: 1250.5,
    current_hours: 0,
    next_service_hours: null,
    next_service_type: "",
    assigned_to: "",
    status: "active",
    book_value: null,
    notes: "Synthetic asset draft",
  });
  await dialog.waitFor({ state: "hidden" });
  await toast(page, "Equipment added");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Name *", { exact: true })
    .fill("Example updated truck");
  const updated = await retryWrite(
    page,
    state,
    `PUT /api/admin/equipment/equipment/${id}`,
    dialog.getByRole("button", { name: "Save", exact: true }),
    async () => {
      assert.equal(
        await page.getByLabel("Name *", { exact: true }).inputValue(),
        "Example updated truck",
      );
    },
  );
  assert.deepEqual(updated, { ...equipment, name: "Example updated truck" });
  await dialog.waitFor({ state: "hidden" });
  await toast(page, "Equipment updated");

  await section(page, "Tank Mixes", null, "tank-mixes");
  const recalculated = await retryWrite(
    page,
    state,
    "POST /api/admin/equipment/tank-mixes/mix-example/recalculate",
    page.getByRole("button", { name: "Recalc", exact: true }),
    async () => {
      assert.equal(
        await page.getByText("Synthetic tank mix", { exact: true }).isVisible(),
        true,
      );
    },
  );
  assert.equal(recalculated, null);
  await toast(page, "Costs recalculated");

  await section(page, "Maintenance", null, "maintenance");
  const resolved = await retryWrite(
    page,
    state,
    "PUT /api/admin/equipment-maintenance/alerts/alert-example",
    page.getByRole("button", { name: "Dismiss", exact: true }),
  );
  assert.deepEqual(resolved, { status: "resolved", resolved_by: "admin" });
  assert.equal(
    await page
      .getByText("Synthetic maintenance review", { exact: true })
      .count(),
    0,
  );
  await fleetDetail(page);
  await page
    .getByRole("button", { name: "Record Maintenance", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Save Record", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByLabel("Schedule (optional)", { exact: true })
    .selectOption(schedule.id);
  await fillFields(page, {
    "Performed By": "Fixture operator",
    "Miles at Service": "12010",
    "Parts Cost": "12.50",
    "Labor Cost": "0",
  });
  const maintenance = await retryWrite(
    page,
    state,
    `POST /api/admin/equipment-maintenance/${id}/records`,
    page.getByRole("button", { name: "Save Record", exact: true }),
    async () => {
      assert.equal(
        await page.getByLabel("Task Name *", { exact: true }).inputValue(),
        schedule.task_name,
      );
      assert.equal(
        await page.getByLabel("Parts Cost", { exact: true }).inputValue(),
        "12.50",
      );
      await shot(page, report, device + "-failed-maintenance-save",
        page.getByRole("alert").filter({ hasText: /Synthetic request failed|HTTP 503/ }));
      await shot(page, report, device + "-failed-maintenance-save-actions",
        page.getByRole("button", { name: "Save Record", exact: true }));
    },
    async () => {
      assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
      assert.equal(
        await page
          .getByRole("button", {
            name: new RegExp("^(Expand|Collapse) .*" + equipment.name),
          })
          .isDisabled(),
        true,
        "Card toggle disabled while a form save is pending",
      );
    },
  );
  assert.deepEqual(maintenance, {
    scheduleId: schedule.id,
    maintenanceType: "scheduled",
    taskName: schedule.task_name,
    description: null,
    performedBy: "Fixture operator",
    vendorName: null,
    milesAtService: 12010,
    hoursAtService: null,
    conditionBefore: null,
    conditionAfter: null,
    partsCost: 12.5,
    laborCost: 0,
    vendorCost: 0,
    downtimeHours: 0,
    followUpNeeded: false,
    followUpNotes: null,
    followUpDate: null,
    warrantyClaim: false,
  });
  await toast(page, "Maintenance recorded");
  await page.getByRole("button", { name: "Log Mileage", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Save Mileage", exact: true })
      .isDisabled(),
    true,
  );
  const logDate = await page.getByLabel("Date", { exact: true }).inputValue();
  await fillFields(page, {
    "Odometer End": "12100",
    "Personal Miles": "10",
    "Fuel Gallons": "5",
    "Fuel Cost ($)": "20",
    "Jobs Serviced": "3",
    "Logged By": "Fixture operator",
    Notes: "Synthetic mileage draft",
  });
  const logged = await retryWrite(
    page,
    state,
    `POST /api/admin/equipment-maintenance/${id}/mileage`,
    page.getByRole("button", { name: "Save Mileage", exact: true }),
    async () => {
      assert.equal(
        await page.getByLabel("Odometer End", { exact: true }).inputValue(),
        "12100",
      );
      assert.equal(
        await page.getByLabel("Notes", { exact: true }).inputValue(),
        "Synthetic mileage draft",
      );
      await shot(page, report, device + "-failed-mileage-save",
        page.getByRole("alert").filter({ hasText: /Synthetic request failed|HTTP 503/ }));
      await shot(page, report, device + "-failed-mileage-save-actions",
        page.getByRole("button", { name: "Save Mileage", exact: true }));
    },
    async () => {
      assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
      assert.equal(
        await page
          .getByRole("button", {
            name: new RegExp("^(Expand|Collapse) .*" + equipment.name),
          })
          .isDisabled(),
        true,
        "Card toggle disabled while a form save is pending",
      );
    },
  );
  assert.deepEqual(logged, {
    logDate,
    odometerStart: 12000,
    odometerEnd: 12100,
    personalMiles: 10,
    fuelGallons: 5,
    fuelCost: 20,
    jobsServiced: 3,
    loggedBy: "Fixture operator",
    notes: "Synthetic mileage draft",
    source: "manual",
  });
  await toast(page, "Mileage logged");

  await section(page, "Maintenance", "Calibrations", "calibrations");
  const saveCalibration = page.getByRole("button", {
    name: "Save Calibration (expires in 30 days)",
    exact: true,
  });
  assert.equal(await saveCalibration.isDisabled(), true);
  await page
    .getByLabel("Equipment system", { exact: true })
    .selectOption(systemId);
  await page.getByText("Current active calibration", { exact: true }).waitFor();
  await fillFields(page, {
    "Test area (sqft)": "1500",
    "Captured gallons": "3",
    "Pressure (PSI, optional)": "40",
    "Engine RPM (optional)": "1800",
    "Notes (optional)": "Synthetic calibration draft",
  });
  const calibrated = await retryWrite(
    page,
    state,
    `POST /api/admin/equipment-systems/${systemId}/calibrations`,
    saveCalibration,
    async () => {
      assert.equal(
        await page.getByLabel("Test area (sqft)", { exact: true }).inputValue(),
        "1500",
      );
      assert.equal(
        await page.getByLabel("Notes (optional)", { exact: true }).inputValue(),
        "Synthetic calibration draft",
      );
      await shot(page, report, device + "-failed-calibration-save",
        page.getByRole("alert").filter({ hasText: /Synthetic request failed|HTTP 503/ }));
      await shot(page, report, device + "-failed-calibration-save-actions",
        page.getByRole("button", { name: "Save Calibration (expires in 30 days)", exact: true }));
    },
    async () =>
      assert.equal(
        await page.getByLabel("Equipment system", { exact: true }).isDisabled(),
        true,
      ),
  );
  assert.deepEqual(calibrated, {
    carrier_gal_per_1000: 2,
    test_area_sqft: 1500,
    captured_gallons: 3,
    pressure_psi: 40,
    engine_rpm_setting: "1800",
    notes: "Synthetic calibration draft",
  });
  await page.getByText(/Calibration saved at/).waitFor();
  assert.equal(
    await page.getByLabel("Test area (sqft)", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Equipment system", { exact: true }).inputValue(),
    systemId,
  );
  await page
    .getByRole("button", { name: "Verify Calibration", exact: true })
    .click();
  const verifyCalibration = page.getByRole("button", {
    name: "Mark Field Verified",
    exact: true,
  });
  assert.equal(await verifyCalibration.isDisabled(), true);
  const verifyDate = await page
    .getByLabel("Verification date", { exact: true })
    .inputValue();
  await fillFields(page, {
    "Measured sqft": "2000",
    "Measured gallons": "4",
    "Verification notes": "Synthetic verification draft",
  });
  const verified = await retryWrite(
    page,
    state,
    `POST /api/admin/equipment-systems/calibrations/${calibrationId}/verify`,
    verifyCalibration,
    async () => {
      assert.equal(
        await page.getByLabel("Measured sqft", { exact: true }).inputValue(),
        "2000",
      );
      assert.equal(
        await page
          .getByLabel("Verification notes", { exact: true })
          .inputValue(),
        "Synthetic verification draft",
      );
      await shot(page, report, device + "-failed-calibration-verification",
        page.getByRole("alert").filter({ hasText: /Synthetic request failed|HTTP 503/ }));
      await shot(page, report, device + "-failed-calibration-verification-actions",
        page.getByRole("button", { name: "Mark Field Verified", exact: true }));
    },
  );
  assert.deepEqual(verified, {
    verified_test_area_sqft: 2000,
    verified_captured_gallons: 4,
    // The fixture browser uses America/New_York; noon must be serialized with its DST offset.
    verified_at: await page.evaluate((date) => new Date(`${date}T12:00:00`).toISOString(), verifyDate),
    verification_notes: "Synthetic verification draft",
  });
  await verifyCalibration.waitFor({ state: "hidden" });
  await page.getByText("Field verified", { exact: true }).waitFor();
  state.toasts = await page.evaluate(() => window.__toasts || []);
}
async function analyticsIndependence(page, server, state) {
  for (const key of [
    "GET /api/admin/equipment-maintenance/alerts",
    "GET /api/admin/equipment-maintenance",
    "GET /api/admin/equipment-maintenance/analytics/overview",
  ]) {
    for (const mode of ["failure", "pending"]) {
      const matches = (request) => requestKey(request) === key;
      let response;
      if (mode === "failure") {
        state.failures.add(key);
        response = page.waitForResponse((r) => matches(r.request()) && r.status() === 503);
      } else {
        state.hold = { key };
        state.hold.promise = new Promise((resolve) => { state.hold.release = resolve; });
        response = page.waitForRequest(matches);
      }
      try {
        await page.goto(server.baseUrl + "/admin/equipment?tab=analytics");
        await response;
        await page.getByText("Cost of Ownership", { exact: true }).waitFor();
        await page.getByRole("row").filter({ hasText: equipment.name }).first().waitFor();
        assert.equal(await page.getByText("Loading equipment analytics…", { exact: true }).isVisible(), false);
        assert.equal(await page.getByRole("alert").filter({ hasText: "Could not load fleet:" }).count(), 0);
        assert.equal(await page.getByRole("alert").filter({ hasText: "Could not load analytics:" }).count(), 0);
        state.checks.push(`Analytics stays available during ${key} ${mode}`);
      } finally {
        state.failures.delete(key);
        if (state.hold) {
          const released = page.waitForResponse((r) => matches(r.request()));
          state.hold.release();
          state.hold = null;
          await released;
        }
      }
    }
  }
}
async function readsAndNavigation(page, server, state, report, device) {
  await analyticsIndependence(page, server, state);
  // `recovered` is the marker each retry has to put on screen, and it has to be
  // content only that response can render. A static card heading — "Equipment
  // Calibration", "Cost of Ownership" — stays visible for the whole failure, so
  // waiting on one proved nothing about the retry: the alert is cleared on the
  // click rather than on the response, and the request counter below moves at
  // interception, so both were already satisfied before any body came back.
  const text = (value) => (page) =>
    page.getByText(value, { exact: true }).first().waitFor();
  for (const [tab, key, message, recovered] of [
    [
      "assets",
      "GET /api/admin/equipment/equipment",
      "Could not load equipment:",
      text(equipment.name),
    ],
    [
      "maintenance",
      "GET /api/admin/equipment-maintenance",
      "Could not load fleet:",
      text(equipment.name),
    ],
    [
      // The systems response is what fills the rig picker; its options sit in a
      // closed <select>, so they are asserted attached rather than visible.
      "calibrations",
      "GET /api/admin/equipment-systems",
      "Could not load equipment systems:",
      (page) =>
        page
          .locator("option")
          .filter({ hasText: system.name })
          .first()
          .waitFor({ state: "attached" }),
    ],
    [
      // The reconciliation card shows "Reconciliation report unavailable." until
      // its own report arrives, and only then the linked-summary tiles.
      "calibrations",
      "GET /api/admin/equipment-systems/reconciliation",
      "Could not load equipment reconciliation:",
      async (page) => {
        await page.getByText("Systems linked", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByText("Reconciliation report unavailable.", { exact: true })
            .count(),
          0,
          "reconciliation report recovered",
        );
      },
    ],
    [
      "tank-mixes",
      "GET /api/admin/equipment/tank-mixes",
      "Could not load tank mixes.",
      text("Synthetic tank mix"),
    ],
    [
      // The summary tiles render only once a summary is in hand.
      "job-costs",
      "GET /api/admin/equipment/job-costs/summary",
      "Could not load job costs:",
      text("Avg Margin"),
    ],
    [
      // "Cost of Ownership" is the card heading and survives the failure; the
      // totals footer is rendered only for a non-empty costs response.
      "analytics",
      "GET /api/admin/equipment-maintenance/analytics/costs",
      "Could not load analytics:",
      text("Totals"),
    ],
  ]) {
    state.failures.add(key);
    await page.goto(
      server.baseUrl + `/admin/equipment?tab=${tab}&source=synthetic`,
    );
    const alert = page.getByRole("alert").filter({ hasText: message });
    await alert.waitFor();
    await geometry(page, state, tab + "-read-error");
    if (tab === "assets") await shot(page, report, device + "-read-error");
    const before = state.requests.filter((r) => r.key === key).length;
    state.failures.delete(key);
    // Awaited before the next iteration's navigation can abort it, so a retry
    // whose response is dropped fails here instead of passing on a counter that
    // moved when the request was intercepted.
    const response = page.waitForResponse(
      (r) => requestKey(r.request()) === key && r.ok(),
    );
    await alert.getByRole("button", { name: /Try again|Retry/ }).click();
    await response;
    await alert.waitFor({ state: "hidden" });
    await recovered(page);
    assert.ok(
      state.requests.filter((r) => r.key === key).length > before,
      key + " retries",
    );
    state.checks.push(key + " failure and read retry");
  }
  state.empty = true;
  // A leaf's own empty copy is not evidence the account reads as empty: every
  // figure rendered beside the list comes from a different endpoint. While only
  // the list was emptied and only the list was asserted, a "1 asset" fleet tile
  // and a "1/1 linked" reconciliation summary sat over an account with nothing
  // in it and nothing caught it. Each leaf now empties, and checks, its
  // neighbours as well.
  // StatCard and SummaryTile render the label and then the value as sibling
  // divs; the job-cost tiles put the value first. Either way the figure is read
  // off its label rather than by position.
  const figure = (label) =>
    page
      .getByText(label, { exact: true })
      .locator("xpath=following-sibling::div[1]");
  const jobFigure = (label) =>
    page
      .getByText(label, { exact: true })
      .locator("xpath=preceding-sibling::div[1]");
  // Cards that are rendered only for a non-empty response, and so must be gone
  // from an empty account.
  const absent = async (...labels) => {
    for (const label of labels)
      assert.equal(
        await page.getByText(label, { exact: true }).count(),
        0,
        label + " on an empty account",
      );
  };
  for (const [tab, text, neighbours] of [
    ["assets", "No equipment recorded.", null],
    [
      "maintenance",
      "No equipment found",
      async () => {
        // The YTD figures come from the overview's own fields rather than from
        // the equipment list, so counts alone would keep passing if either the
        // assets guard in fleetOverview() or its empty mileage input were lost
        // and real spend stood beside "No equipment found".
        for (const [label, value] of [
          ["Total Assets", "0"],
          ["Overdue Maintenance", "0"],
          ["YTD Maintenance", "$0.00"],
          ["YTD Mileage", "0"],
          ["YTD Fuel", "$0.00"],
          ["YTD IRS Deduction", "$0.00"],
        ])
          assert.equal(
            await figure(label).innerText(),
            value,
            label + " on an empty account",
          );
      },
    ],
    ["tank-mixes", "No tank mixes configured", null],
    [
      "job-costs",
      "No job costs recorded yet",
      async () => {
        assert.equal(await jobFigure("Avg Margin").innerText(), "0.0%");
        assert.equal(await jobFigure("Total Jobs Costed").innerText(), "0");
      },
    ],
    [
      // The analytics tab has no empty copy of its own — every card here is
      // rendered only when its own response carried rows, so their absence is
      // what an empty account looks like. "Cost of Ownership" is the static
      // heading that says the tab rendered at all.
      "analytics",
      "Cost of Ownership",
      async () => {
        await absent(
          "Totals",
          "Upcoming Maintenance (Next 30 Days)",
          "Reliability Ranking (Downtime Hours)",
          "Maintenance Cost Trend (Last 6 Months)",
        );
        // Costs, mileage and due schedules all name the vehicle when they have
        // rows for it.
        assert.equal(
          await page.locator("main").getByText(equipment.name).count(),
          0,
          "vehicle rows on an empty account",
        );
      },
    ],
    [
      "calibrations",
      "No equipment systems are available for calibration.",
      async () => {
        assert.equal(await figure("Systems linked").innerText(), "0/0");
        assert.equal(await figure("Equipment tax links").innerText(), "0/0");
        // Only the "— select a spray rig —" placeholder is left.
        assert.equal(await page.locator("option").count(), 1);
      },
    ],
  ]) {
    await page.goto(server.baseUrl + `/admin/equipment?tab=${tab}`);
    await page.getByText(text, { exact: false }).waitFor();
    assert.equal(
      await page.locator("main").getByRole("alert").count(),
      0,
      tab + " true empty",
    );
    if (neighbours) await neighbours();
    state.checks.push(tab + " empty");
  }
  state.empty = false;
  for (const [alias, group] of [
    ["equipment", "Assets"],
    ["fleet", "Maintenance"],
    ["vehicles", "Maintenance"],
    ["mileage", "Maintenance"],
    ["invalid", "Assets"],
  ]) {
    await page.goto(
      server.baseUrl + `/admin/equipment?tab=${alias}&source=synthetic`,
    );
    await page.getByText(equipment.name, { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("navigation", { name: "Equipment section", exact: true })
        .getByRole("button", { name: group, exact: true })
        .getAttribute("aria-current"),
      "page",
    );
  }
  await section(page, "Maintenance", null, "maintenance");
  const historyLength = await page.evaluate(() => history.length);
  const maintenanceTab = page.getByRole("tab", {
    name: "Maintenance",
    exact: true,
  });
  await maintenanceTab.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByLabel("Equipment system", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "calibrations");
  assert.equal(new URL(page.url()).searchParams.get("source"), "synthetic");
  assert.equal(
    await page.evaluate(() => history.length),
    historyLength,
    "Leaf selection replaces history",
  );
  await page.keyboard.press("Home");
  await page.getByText(equipment.name, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "maintenance");
  await page.reload();
  await page.getByText(equipment.name, { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "Maintenance", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.goto(server.baseUrl + "/admin/equipment?tab=analytics");
  await page.getByText("Cost of Ownership", { exact: true }).waitFor();
  await page.goBack();
  await page.getByText(equipment.name, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "maintenance");
  await page.goForward();
  await page.getByText("Cost of Ownership", { exact: true }).waitFor();
  state.checks.push(
    "Aliases, keyboard tabs, unrelated query preservation, refresh and history",
  );
  for (const role of ["technician", "csr"]) {
    state.role = role;
    const before = state.requests.length;
    await page.goto(server.baseUrl + "/admin/equipment?tab=analytics");
    await page.getByText(equipment.name, { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("navigation", { name: "Equipment section", exact: true })
        .getByRole("button", { name: "Costs", exact: true })
        .count(),
      0,
    );
    assert.equal(
      state.requests
        .slice(before)
        .some((r) =>
          /\/job-costs|\/analytics\/(costs|reliability)/.test(r.key),
        ),
      false,
      role + " does not fetch owner-only panels",
    );
    await section(page, "Maintenance", "Calibrations", "calibrations");
    await page.getByLabel("Equipment system", { exact: true }).waitFor();
    state.checks.push(
      role + " uses verified role despite cached admin identity",
    );
  }
  state.role = "admin";
  // A failed fleet-card detail read is logged, not surfaced: the card expands
  // with no detail block and no alert, and the read is only retried when the
  // card is collapsed and expanded again (registered as ADMIN-BUG-006).
  const detailKey = `GET /api/admin/equipment-maintenance/${id}`;
  state.failures.add(detailKey);
  await page.goto(server.baseUrl + "/admin/equipment?tab=maintenance");
  const cardToggle = page.getByRole("button", {
    name: new RegExp("^(Expand|Collapse) .*" + equipment.name),
  });
  const detailFailed = page.waitForResponse(
    (r) =>
      new URL(r.request().url()).pathname ===
        `/api/admin/equipment-maintenance/${id}` && r.status() === 503,
  );
  await cardToggle.click();
  await detailFailed;
  await page.waitForTimeout(250);
  assert.equal(
    await page
      .getByRole("button", { name: "Record Maintenance", exact: true })
      .count(),
    0,
    "Failed detail read renders no detail block",
  );
  assert.equal(
    await page.locator("main").getByRole("alert").count(),
    0,
    "Failed detail read surfaces no alert",
  );
  await geometry(page, state, "maintenance-detail-error");
  state.failures.delete(detailKey);
  await cardToggle.click();
  await cardToggle.click();
  await page
    .getByRole("button", { name: "Record Maintenance", exact: true })
    .waitFor();
  state.checks.push("Fleet detail read failure and re-expansion recovery");

  state.failures.add(`GET /api/admin/equipment-systems/${systemId}`);
  await page.goto(server.baseUrl + "/admin/equipment?tab=calibrations");
  await page.getByLabel("Equipment system", { exact: true }).selectOption(systemId);
  const calibrationAlert = page
    .getByRole("alert")
    .filter({ hasText: "Could not load current calibration:" });
  await calibrationAlert.waitFor();
  await geometry(page, state, "calibrations-detail-error");
  state.failures.delete(`GET /api/admin/equipment-systems/${systemId}`);
  await calibrationAlert
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await page.getByText("Current active calibration", { exact: true }).waitFor();
  await calibrationAlert.waitFor({ state: "hidden" });
  state.checks.push("Calibration detail failure and retry");
  state.jobSummary = {
    totalJobs: 1,
    avgRevenue: 0,
    avgCost: null,
    avgMargin: null,
  };
  await page.goto(server.baseUrl + "/admin/equipment?tab=job-costs");
  await page.getByText("Avg Revenue/Job", { exact: true }).waitFor();
  assert.match(
    await page
      .getByText("Avg Revenue/Job", { exact: true })
      .locator("..")
      .innerText(),
    /\$0\.00/,
  );
  assert.match(
    await page
      .getByText("Avg Cost/Job", { exact: true })
      .locator("..")
      .innerText(),
    /—/,
  );
  assert.match(
    await page
      .getByText("Avg Margin", { exact: true })
      .locator("..")
      .innerText(),
    /—/,
  );
  state.checks.push("Missing job metrics remain distinct from zero");
  state.jobSummary = null;
  state.assetName =
    "Synthetic asset with a long equipment name and identifier " +
    "QA0123456789".repeat(5);
  await page.goto(server.baseUrl + "/admin/equipment");
  await page.getByText(state.assetName, { exact: true }).waitFor();
  await widths(page, state, "long-asset-name");
  await shot(page, report, device + "-long-asset-name");
  state.assetName = null;
  state.checks.push(
    "Long asset name preserves visible controls and page bounds",
  );
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const sourceFiles = [
    "client/src/components/admin/AdminCommandHeader.jsx",
    "client/src/pages/admin/EquipmentPage.jsx",
    "client/src/pages/admin/EquipmentMaintenancePage.jsx",
    "client/src/pages/admin/EquipmentCalibrationPanel.jsx",
    "scripts/qa/admin-equipment-foundation.js",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      require("node:crypto")
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
  const report = {
    ...evidence(root),
    sourceHashes,
    screenshots: [],
    browsers: [],
  };
  const server = await previewServer(root);
  try {
    for (const [device, launch, viewport, hasTouch] of [
      ["desktop", launchBrowser, { width: 1440, height: 1000 }, false],
      [
        "touch-webkit",
        () => webkit.launch({ headless: true }),
        { width: 390, height: 844 },
        true,
      ],
    ]) {
      const state = {
        requests: [],
        badQuery: [],
        dialogs: [],
        pageErrors: [],
        consoleErrors: [],
        expectedFailures: [],
        unmatched: [],
        failures: new Set(),
        geometry: [],
        checks: [],
      };
      report.browsers.push({ device, state });
      // The launch and page creation are inside the recorded lifecycle: a
      // WebKit launch that fails after Chromium has finished used to throw
      // outside it, and the outer finally still wrote report.json and the
      // gallery with only the successful evidence and nothing saying why the
      // required touch-webkit pass was missing.
      let browser, page;
      try {
        browser = await launch();
        page = await browser.newPage({
          viewport,
          hasTouch,
          timezoneId: "America/New_York",
          serviceWorkers: "block",
        });
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(45000);
        await install(page, server, state);
        await views(page, server, state, report, device);
        // Up to here the run has only viewed: the view pass opens dialogs but
        // always Cancels, so the one write it may have issued is the admin
        // usage beacon. Asserted between the passes rather than at the end,
        // because the writes pass below performs and asserts each of those
        // requests deliberately.
        assert.deepEqual(
          state.requests
            .map((request) => request.key)
            .filter(
              (key) =>
                !key.startsWith("GET ") &&
                key !== "POST /api/admin/usage/track",
            ),
          [],
          "Unexpected write during the view pass",
        );
        await writes(page, server, state, report, device);
        await readsAndNavigation(page, server, state, report, device);
        assert.deepEqual(state.pageErrors, [], "Page errors");
        assert.deepEqual(state.unmatched, [], "Unmatched API");
        assert.deepEqual(state.badQuery, [], "Query contract");
        assert.deepEqual(state.dialogs, [], "Unexpected native dialog");
        // A leaf that stops fetching leaves its fixture simply unused: the
        // geometry and malformed-text checks still pass and the run still
        // reports success while no longer exercising that response contract at
        // all. Only GETs — the writes pass asserts its own requests.
        const requested = new Set(
          state.requests.map((request) => request.key),
        );
        assert.deepEqual(
          state.fixtureGets.filter((key) => !requested.has(key)),
          [],
          "Unexercised fixture",
        );
        // The injected 503s are expected, so their console noise is filtered by
        // the exact URLs this run failed on rather than by matching text.
        assert.deepEqual(
          state.consoleErrors.filter(
            (e) =>
              !(
                e.text.includes("503") &&
                (!e.url || state.expectedFailures.includes(e.url))
              ),
          ),
          [],
          "Unexpected console errors",
        );
      } catch (error) {
        report.error = error.stack;
        report.failedDevice = device;
        if (page)
          await shot(page, report, device + "-failure").catch(() => {});
        throw error;
      } finally {
        state.hold?.release?.();
        if (page)
          await page
            .evaluate(() => localStorage.removeItem("waves_admin_token"))
            .catch(() => {});
        if (browser) await browser.close();
      }
    }
  } finally {
    gallery(report);
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await server.close();
  }
  console.log("Equipment UI checks passed.");
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
