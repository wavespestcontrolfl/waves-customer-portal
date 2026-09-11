"use strict";
/* global document, localStorage, navigator, getComputedStyle, innerWidth, requestAnimationFrame, history, window */
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
    next_due_at: "2026-10-01",
    is_overdue: false,
  },
};
const schedule = {
  id: "schedule-example",
  task_name: "Synthetic inspection",
  interval_miles: 5000,
  interval_months: 6,
  next_due_at: "2026-10-01",
  priority: "normal",
  estimated_cost: 100,
  is_overdue: false,
  equipment_name: equipment.name,
  category: "vehicle",
  asset_tag: "QA-001",
};
const record = {
  id: "record-example",
  task_name: "Synthetic oil change",
  maintenance_type: "scheduled",
  performed_by: "Fixture operator",
  performed_at: "2026-09-01T12:00:00Z",
  total_cost: 100,
};
const mileage = {
  logs: [
    {
      id: "mileage-example",
      log_date: "2026-09-08",
      odometer_start: 11900,
      odometer_end: 12000,
      total_miles: 100,
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
  summary: {
    total_miles: 100,
    business_miles: 90,
    total_fuel_cost: 20,
    total_irs_deduction: 63,
    avg_mpg: 20,
  },
};
const overview = {
  total_assets: 1,
  overdue_maintenance: 0,
  ytd_maintenance_spend: 100,
  ytd_total_miles: 100,
  ytd_fuel_cost: 20,
  ytd_irs_deduction: 63,
};
const cost = {
  equipment_id: id,
  equipment_name: equipment.name,
  category: "vehicle",
  asset_tag: "QA-001",
  age_months: 32,
  purchase_price: 25000,
  total_maintenance: 100,
  total_fuel: 20,
  total_cost: 25120,
  monthly_cost: 785,
  condition_rating: 8,
  total_irs_deduction: 63,
};
// Matches the job-cost summary below (1 pest job, $250 revenue, $100 cost,
// 60% margin) so the list and the summary cannot disagree — the real
// endpoints read the same `job_costs` table and never do.
const jobCost = {
  id: "job-cost-example",
  service_record_id: null,
  customer_id: "customer-example",
  customer_name: "Fixture Customer",
  service_date: "2026-09-05",
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
  expires_at: "2026-10-01T12:00:00Z",
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
function easternYear() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
    }).format(new Date()),
  );
}
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
        state.jobSummary || {
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
      () => ({ job_costs: [jobCost], costs: [jobCost], total: 1, page: 1 }),
    ],
    [
      "GET /api/admin/equipment-maintenance",
      () => ({ equipment: state.empty ? [] : [equipment] }),
    ],
    ["GET /api/admin/equipment-maintenance/analytics/overview", () => overview],
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
        costOfOwnership: cost,
      }),
    ],
    [
      `GET /api/admin/equipment-maintenance/${id}/mileage`,
      () => ({ ...mileage, logs: state.mileageLogs || mileage.logs }),
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
      () => ({ costs: [cost] }),
    ],
    [
      "GET /api/admin/equipment-maintenance/analytics/reliability",
      () => ({
        reliability: [
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
      (url) => ({
        year: Number(url.searchParams.get("year")) || easternYear(),
        vehicles: [
          {
            id,
            name: equipment.name,
            asset_tag: "QA-001",
            total_miles: 100,
            business_miles: 90,
            total_fuel_cost: 20,
            total_irs_deduction: 63,
            total_jobs: 3,
          },
        ],
        fleet_totals: {
          total_miles: 100,
          business_miles: 90,
          total_fuel_cost: 20,
          total_irs_deduction: 63,
          total_jobs: 3,
        },
      }),
    ],
    [
      "GET /api/admin/equipment-maintenance/schedules/due",
      () => ({ schedules: [schedule] }),
    ],
    [
      "GET /api/admin/equipment-maintenance/records/recent",
      () => ({ records: [record] }),
    ],
    [
      "GET /api/admin/equipment-systems",
      () => ({ systems: state.empty ? [] : [system] }),
    ],
    [
      "GET /api/admin/equipment-systems/reconciliation",
      () => ({
        systems: [system],
        equipment: [{ ...equipment, tax_register: taxRegisterAsset }],
        issues: [],
        summary: {
          systems_with_any_equipment_link: 1,
          systems_active: 1,
          systems_without_equipment_link: 0,
          equipment_with_tax_link: 1,
          equipment_active: 1,
          tax_register_unlinked: 0,
        },
      }),
    ],
    [
      `GET /api/admin/equipment-systems/${systemId}`,
      () => ({ system, calibration: state.calibration || calibration }),
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
async function install(page, server, state) {
  const handlers = fixtures(state),
    contracts = queryContracts();
  await page.addInitScript(() => {
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
  page.on("dialog", (dialog) =>
    dialog.accept(dialog.type() === "prompt" ? "80" : undefined),
  );
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
    const contract = contracts.get(key);
    if (contract) {
      const violation = contract(url.searchParams);
      if (violation) state.badQuery.push(`${key} (${violation})`);
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
  state.mileageLogs = Array.from({ length: 30 }, (_, index) => ({
    ...mileage.logs[0],
    id: `mileage-example-${index}`,
  }));
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
  await chart.evaluate((node) => { node.scrollLeft = node.scrollWidth - node.clientWidth; });
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
      const browser = await launch();
      const state = {
        requests: [],
        badQuery: [],
        pageErrors: [],
        consoleErrors: [],
        unmatched: [],
        geometry: [],
        checks: [],
      };
      report.browsers.push({ device, state });
      const page = await browser.newPage({
        viewport,
        hasTouch,
        timezoneId: "America/New_York",
        serviceWorkers: "block",
      });
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(45000);
      try {
        await install(page, server, state);
        await views(page, server, state, report, device);
        assert.deepEqual(state.pageErrors, [], "Page errors");
        assert.deepEqual(state.unmatched, [], "Unmatched API");
        assert.deepEqual(state.badQuery, [], "Query contract");
        // This is a view-only run: it opens dialogs but always Cancels, so the
        // only write it may issue is the admin usage beacon. The write handlers
        // below answer 200, so without this an accidental Save/Recalc/Dismiss
        // would be quietly accepted instead of landing in state.unmatched —
        // the writes runner asserts each of those requests individually.
        assert.deepEqual(
          state.requests
            .map((request) => request.key)
            .filter(
              (key) =>
                !key.startsWith("GET ") &&
                key !== "POST /api/admin/usage/track",
            ),
          [],
          "Unexpected write",
        );
        assert.deepEqual(state.consoleErrors, [], "Unexpected console errors");
      } catch (error) {
        report.error = error.stack;
        await shot(page, report, device + "-failure");
        throw error;
      } finally {
        await page
          .evaluate(() => localStorage.removeItem("waves_admin_token"))
          .catch(() => {});
        await browser.close();
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
