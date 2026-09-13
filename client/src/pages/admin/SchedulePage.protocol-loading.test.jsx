// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ProtocolPanel } from "./SchedulePage";

const service = {
  id: "visit-fixture-a", customerId: "customer-fixture-a",
  serviceType: "Lawn Care", customerName: "Fixture account",
  lawnType: "St. Augustine", lawnSqft: 10000,
};
const reply = (body, status = 200) => Promise.resolve({
  ok: status < 400, status, json: async () => body,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(url, label = "Current") {
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith('/intelligence-bar/quick-actions')) return { actions: [] };
  // The job card is gate-off here (GATE_JOB_CARD unset): the legacy tabs render.
  if (path.includes("/protocols/job-card/")) return { enabled: false };
  // Pay & Growth is gate-off by default; a test that needs the Score tab
  // overrides this with its own fetch mock.
  if (path.endsWith("/pay-growth/availability")) return { available: false };
  if (path.endsWith("/turf-profile")) return { profile: { track_key: "A_St_Aug_Sun", lawn_sqft: 10000 } };
  if (path.endsWith("/photos/relevant")) return { photos: [{ name: `${label} photo guide`, description: "Fixture reference" }] };
  if (path.endsWith("/seasonal-index")) return { pests: [] };
  if (path.endsWith("/scripts")) return { scripts: [] };
  if (path.endsWith("/equipment")) return { checklists: [{ service_type: "Lawn", checklist_items: [{ category: "Equipment", items: [{ item: `${label} sprayer`, required: true }] }] }] };
  if (path.endsWith("/programs")) return { track: { name: `${label} lawn program`, notes: [], visits: [] } };
  if (path.endsWith("/lawn-mix")) return {
    month: "Jul", visit: { visit: 7 }, areaSqft: 10000,
    equipment: { systemName: "Fixture calibrated rig", carrierGalPer1000: 2 },
    items: [{ raw: "Fixture selected product", product: { name: `${label} mix product` }, jobMix: { amount: 2.9, amountUnit: "oz" }, fullTankMix: { amount: 5.8, amountUnit: "oz" } }],
  };
  throw new Error(`Unexpected request: ${path}`);
}

beforeEach(() => {
  // Exercise the real panel and its HTTP error handling; no request leaves the test.
  vi.stubGlobal("fetch", vi.fn((url) => reply(fixture(url))));
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ProtocolPanel mix previews", () => {
  it("uses the server-selected procedure when enabled and opens its SOP without the annual calendar", async () => {
    vi.stubGlobal('scrollTo', vi.fn());
    fetch.mockImplementation((url) => reply(url.includes('/protocols/job-card/') ? {
      enabled: true, serviceId: service.id, strip: { name: 'Fixture account', program: 'Lawn Care' }, products: [], addons: [], planBlocks: [],
      sprayCheck: { window: 'not_today' }, tank: { calibrated: false, reason: 'Fixture rig unavailable' },
      protocol: { enabled: true, procedure: { name: 'Published fixture protocol', source: 'Published protocol · version 3', title: 'September visit', objective: 'Record current conditions.', visitNotes: [], steps: ['Inspect the marked area.'], conditional: [], notes: ['Read the source notes.'] }, addons: [] },
    } : fixture(url)));
    await act(async () => { render(<ProtocolPanel service={service} onClose={() => {}} />); });
    fireEvent.click(screen.getByRole('button', { name: 'Protocol', exact: true }));
    expect(await screen.findByText('September visit')).toBeVisible();
    expect(screen.queryByText('Annual Protocol Calendar')).not.toBeInTheDocument();
    const opener = screen.getByRole('button', { name: 'Read SOP' });
    opener.focus();
    fireEvent.click(opener);
    expect(within(screen.getByRole('dialog', { name: 'Service SOP' })).getByText('Read the source notes.')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Service SOP' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Service Protocol' })).toBeVisible();
    expect(opener).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'View product checks and mixing amounts' }));
    expect(screen.getByText('Spray check')).toBeVisible();
  });

  it("shows labeled optional quantities and prefers actual quantities for selected products", async () => {
    fetch.mockImplementation((url) => {
      const body = fixture(url);
      if (url.includes("/lawn-mix")) {
        body.items = [
          { raw: "Base instruction", selected: true, product: { name: "Selected product" }, jobMix: { amount: 30, amountUnit: "fl_oz" }, fullTankMix: { amount: 60, amountUnit: "fl_oz" }, plannedMix: { amount: 999, amountUnit: "fl_oz" }, plannedFullTankMix: { amount: 1998, amountUnit: "fl_oz" } },
          { raw: "If rescue is needed", selected: false, product: { name: "Rescue product" }, jobMix: null, fullTankMix: null, plannedMix: { amount: 2.9, amountUnit: "oz" }, plannedFullTankMix: { amount: 5.8, amountUnit: "oz" } },
          { raw: "Premium option", selected: false, product: { name: "Premium product" }, jobMix: null, fullTankMix: null, plannedMix: { amount: 90, amountUnit: "fl_oz" }, plannedFullTankMix: { amount: 180, amountUnit: "fl_oz" } },
        ];
      }
      return reply(body);
    });
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    const selected = within(await screen.findByRole("group", { name: "Selected product" }));
    expect(selected.getByText("30 fl_oz")).toBeVisible();
    expect(selected.getByText("60 fl_oz/tank")).toBeVisible();
    expect(selected.queryByText("Optional preview")).not.toBeInTheDocument();
    expect(selected.queryByText(/999|1998/)).not.toBeInTheDocument();
    const rescue = within(screen.getByRole("group", { name: "Rescue product" }));
    expect(rescue.getByText("Optional preview")).toBeVisible();
    expect(rescue.getByText("If rescue is needed")).toBeVisible();
    expect(rescue.getByText("2.9 oz")).toBeVisible();
    expect(rescue.getByText("5.8 oz/tank")).toBeVisible();
    const premium = within(screen.getByRole("group", { name: "Premium product" }));
    expect(premium.getByText("Optional preview")).toBeVisible();
    expect(premium.getByText("90 fl_oz")).toBeVisible();
    expect(premium.getByText("180 fl_oz/tank")).toBeVisible();
    // Previewing does not select products or submit applications.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
  });

  it.each([
    ["SKIP instruction", null],
    ["Missing calibration", { code: "missing_calibration", message: "No active calibration. Quantities withheld." }],
    ["Expired calibration", { code: "expired_calibration", message: "Calibration expired. Quantities withheld." }],
  ])("keeps %s quantities unavailable without inventing a preview", async (label, warning) => {
    fetch.mockImplementation((url) => {
      const body = fixture(url);
      if (url.includes("/lawn-mix")) {
        body.items = [{ raw: label, selected: false, product: { name: "Unavailable product" }, jobMix: null, fullTankMix: null, plannedMix: null, plannedFullTankMix: null }];
        body.warnings = warning ? [warning] : [];
      }
      return reply(body);
    });
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    const row = within(await screen.findByRole("group", { name: "Unavailable product" }));
    expect(row.getByText(label)).toBeVisible();
    expect(row.getByText("—")).toBeVisible();
    expect(row.getByText("— /tank")).toBeVisible();
    expect(row.queryByText("Optional preview")).not.toBeInTheDocument();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    if (warning) expect(screen.getByText(warning.message, { exact: false })).toBeVisible();
  });
});

describe("ProtocolPanel independent request failures", () => {
  it("keeps mix and equipment after photo failure and recovers through the visible retry", async () => {
    let failPhotos = true;
    fetch.mockImplementation((url) => url.includes("/photos/relevant") && failPhotos
      ? reply({ error: "Fixture failure" }, 503) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: ID guide.");
    expect(screen.getByText("Current mix product")).toBeVisible();
    expect(screen.getByText("2.9 oz")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^ID Guide/ }));
    expect(screen.getByText("ID guide unavailable")).toBeVisible();
    expect(screen.queryByText("No photo references for this service")).not.toBeInTheDocument();

    failPhotos = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByText("Current photo guide")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains mix and calibration when the annual program fails, then restores the calendar on retry", async () => {
    let failProgram = true;
    fetch.mockImplementation((url) => url.includes("/programs") && failProgram
      ? reply({}, 503) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: Lawn protocol.");
    expect(screen.getByText("Lawn protocol unavailable")).toBeVisible();
    expect(screen.getByText("Current mix product")).toBeVisible();
    expect(screen.getByText("2.9 oz")).toBeVisible();
    expect(screen.getByText("5.8 oz/tank")).toBeVisible();
    expect(screen.getByText(/Fixture calibrated rig/)).toBeVisible();
    expect(screen.queryByText("Annual Protocol Calendar")).not.toBeInTheDocument();

    failProgram = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByText("Annual Protocol Calendar")).toBeVisible();
    expect(screen.getByText("Current mix product")).toBeVisible();
    expect(screen.queryByText("Lawn protocol unavailable")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to Overview when retry removes the selected service protocol", async () => {
    let retry = false;
    fetch.mockImplementation((url) => {
      if (url.includes("/match?")) return retry ? reply({}, 503)
        : reply({ program: { name: "Fixture pest protocol", notes: [], visits: [] } });
      if (url.includes("/photos/relevant") && !retry) return reply({}, 503);
      return reply(fixture(url));
    });
    render(<ProtocolPanel service={{ ...service, serviceType: "Pest Control" }} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ID guide");
    fireEvent.click(screen.getByRole("button", { name: /^Protocol/ }));
    expect(screen.getByText("Fixture pest protocol")).toBeVisible();
    retry = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Service protocol");
    expect(screen.queryByRole("button", { name: /^Protocol/ })).not.toBeInTheDocument();
    expect(screen.getByText("Service Overview")).toBeVisible();
    expect(screen.queryByText("Fixture pest protocol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
  });

  it("withholds failed mix quantities while retaining the program and equipment", async () => {
    fetch.mockImplementation((url) => url.includes("/lawn-mix")
      ? Promise.reject(new Error("Fixture network failure")) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: Mix quantities.");
    expect(screen.getAllByText("Current lawn program")[0]).toBeVisible();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture calibrated rig", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
  });

  it("reports a failed turf profile without guessing a species-specific mix", async () => {
    fetch.mockImplementation((url) => url.includes("/turf-profile")
      ? reply({}, 503) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: Turf profile.");
    expect(screen.queryByText("Current mix product")).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => url.includes("/lawn-mix?"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
  });

  it("clears a previous service's guidance when the next service cannot load it", async () => {
    const view = render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByText("Current mix product")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
    fetch.mockImplementation((url) => /\/(equipment|lawn-mix|photos\/relevant)/.test(url)
      ? reply({}, 503) : reply(fixture(url, "Next")));
    view.rerender(<ProtocolPanel service={{ ...service, id: "visit-fixture-b", customerId: "customer-fixture-b" }} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ID guide, Equipment, Mix quantities");
    expect(screen.queryByText("Current mix product")).not.toBeInTheDocument();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Equipment checklist unavailable")).toBeVisible();
    expect(screen.queryByText("Current sprayer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^ID Guide/ }));
    expect(screen.queryByText("Current photo guide")).not.toBeInTheDocument();
  });

  it.each(["turf-profile", "equipment"])("ignores late %s responses from a previous service", async (pendingPath) => {
    const oldResponse = deferred();
    fetch.mockImplementation((url) => url.includes(`/${pendingPath}`)
      ? oldResponse.promise : reply(fixture(url, "Old")));
    const view = render(<ProtocolPanel service={service} onClose={() => {}} />);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes(`/${pendingPath}`))).toBe(true));
    fetch.mockImplementation((url) => reply(fixture(url, "Next")));
    view.rerender(<ProtocolPanel service={{ ...service, id: "visit-fixture-b", customerId: "customer-fixture-b" }} onClose={() => {}} />);
    expect(await screen.findByText("Next mix product")).toBeVisible();
    const callsBeforeOldResponse = fetch.mock.calls.length;
    await act(async () => { oldResponse.resolve(await reply(fixture(`/api/admin/${pendingPath}`, "Old"))); });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeOldResponse);
    expect(screen.getByText("Next mix product")).toBeVisible();
    expect(screen.queryByText("Old mix product")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Next sprayer")).toBeVisible();
    expect(screen.queryByText("Old sprayer")).not.toBeInTheDocument();
  });
});

describe("Job card Tank section rigs", () => {
  const rigs = [
    { equipmentSystemId: "sys-1", name: "110-Gallon Spray Tank #1", tankCapacityGal: 110 },
    { equipmentSystemId: "sys-2", name: "Tank #2", tankCapacityGal: 110 },
    { equipmentSystemId: "sys-3", name: "FlowZone Typhoon 3.0 #1", tankCapacityGal: 4 },
  ];
  const card = {
    enabled: true, serviceId: service.id, strip: { name: "Fixture account", program: "Lawn Care" }, products: [], addons: [], planBlocks: [],
    sprayCheck: { window: "not_today" }, tank: { calibrated: true, source: "rig", rigs },
  };
  const mixCalls = () => fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/job-card/mix"));

  it("lists every rig's gallons as its own section and doses a full tank of the picked rig", async () => {
    fetch.mockImplementation((url) => {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname.endsWith("/protocols/job-card/products")) return reply({ products: [{ id: "p1", name: "Celsius WG", category: "herbicide" }] });
      if (parsed.pathname.endsWith("/protocols/job-card/mix")) {
        const sprayCheck = { verdict: "unknown", reason: "Judged on the visit day" };
        // The rig answer names the volume and rig it was computed for; the
        // section labels the dose from the answer, not its list (here the
        // rig's tank grew to 5 gal after the card loaded).
        return reply(parsed.searchParams.get("rig")
          ? { enabled: true, amount: 1.36, unit: "oz", gallons: 5, coversSqft: 3760, rig: { equipmentSystemId: "sys-3", name: "FlowZone Typhoon 3.0 #1", tankCapacityGal: 5 }, sprayCheck }
          : { enabled: true, amount: 6.215, unit: "oz", gallons: Number(parsed.searchParams.get("gallons")), coversSqft: 55000, sprayCheck });
      }
      if (parsed.pathname.includes("/protocols/job-card/")) return reply(card);
      return reply(fixture(url));
    });
    await act(async () => { render(<ProtocolPanel service={service} onClose={() => {}} />); });
    expect(await screen.findByText("Rigs · full tank")).toBeVisible();
    const rows = rigs.map((r) => screen.getByText(r.name).closest("button"));
    expect(rows.map((row) => row.textContent)).toEqual(["110-Gallon Spray Tank #1110 gal", "Tank #2110 gal", "FlowZone Typhoon 3.0 #14 gal"]);

    fireEvent.change(screen.getByPlaceholderText("Search a product to mix"), { target: { value: "cel" } });
    fireEvent.click(await screen.findByRole("button", { name: "Celsius WG" }));
    expect(await screen.findByText("in 110 gal · covers 55,000 sq ft")).toBeVisible();
    expect(mixCalls().at(-1)).toContain("gallons=110");

    fireEvent.click(rows[2]);
    expect(await screen.findByText("in 5 gal · FlowZone Typhoon 3.0 #1 · covers 3,760 sq ft")).toBeVisible();
    expect(mixCalls().at(-1)).toContain("rig=sys-3");
    expect(mixCalls().at(-1)).not.toContain("gallons=");

    // A preset takes the mix back off the rig.
    fireEvent.click(screen.getByRole("button", { name: "1 gal" }));
    expect(await screen.findByText("in 1 gal · covers 55,000 sq ft")).toBeVisible();
    expect(mixCalls().at(-1)).toContain("gallons=1");
    expect(mixCalls().at(-1)).not.toContain("rig=");
  });
});

describe("Pay & Growth gate", () => {
  afterEach(() => { localStorage.removeItem("waves_admin_user"); });

  it("opens the shared service score only when the pay and growth gate is enabled", async () => {
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    await screen.findByText("Current mix product");
    expect(screen.queryByRole("button", { name: "Score" })).not.toBeInTheDocument();
    cleanup();

    // Score is admin-only, or the assigned technician viewing their own
    // service (/admin/dispatch is reachable by technician-role staff too).
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "admin-1", role: "admin" }));
    fetch.mockImplementation((url) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/pay-growth/availability")) return reply({ available: true });
      if (path.endsWith(`/pay-growth/services/${service.id}/score`)) return reply({ entries: [], can_manage: true });
      return reply(fixture(url));
    });
    render(<MemoryRouter><ProtocolPanel service={service} onClose={() => {}} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Score" }));
    expect(await screen.findByText(/It has not received a passing score/)).toBeVisible();
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/pay-growth/services/${service.id}/score`))).toBe(true);
    expect(screen.getByRole("link", { name: "Open Pay & Growth" })).toHaveAttribute("href", "/admin/timetracking?tab=pay-growth");
  });

  it("hides the Score tab from a technician the score service does not recognise on a colleague's service", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "tech-1", role: "technician" }));
    fetch.mockImplementation((url) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/pay-growth/availability")) return reply({ available: true });
      if (path.endsWith(`/pay-growth/services/${service.id}/score`)) return reply({ error: "Service not found." }, 404);
      return reply(fixture(url));
    });
    render(<ProtocolPanel service={{ ...service, technician_id: "tech-2" }} onClose={() => {}} />);
    await screen.findByText("Current mix product");
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes(`/pay-growth/services/${service.id}/score`))).toBe(true));
    expect(screen.queryByRole("button", { name: "Score" })).not.toBeInTheDocument();
  });

  it("shows the Score tab to a retained participant who is not the assignee, reusing the probe's score", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "tech-1", role: "technician" }));
    const entry = { id: "row-1", service_label: "Crew stop · Fixture account", service_date: "2026-04-05", revision: 1, service_key: "pest_general_quarterly", workweek_start: "2026-03-30",
      calculation: { status: "simulated", amount_cents: 600, value_cents: 10000, rate_bps: 600, reason: null },
      facts: { participants: [{ technician_id: "tech-1", share_bps: 5000 }], source_reference: "visit-fixture-a", complete_at_cutoff: true, cutoff_at: null } };
    fetch.mockImplementation((url) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/pay-growth/availability")) return reply({ available: true });
      if (path.endsWith(`/pay-growth/services/${service.id}/score`)) return reply({ entries: [entry], can_manage: false });
      return reply(fixture(url));
    });
    render(<MemoryRouter><ProtocolPanel service={{ ...service, technician_id: "tech-2" }} onClose={() => {}} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Score" }));
    expect(await screen.findByText("Crew stop · Fixture account")).toBeVisible();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes(`/pay-growth/services/${service.id}/score`))).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open Pay & Growth" })).toHaveAttribute("href", "/tech/pay-growth");
  });

  it("shows the Score tab, with the tech-portal link, for a technician viewing their own service", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ id: "tech-1", role: "technician" }));
    fetch.mockImplementation((url) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/pay-growth/availability")) return reply({ available: true });
      if (path.endsWith(`/pay-growth/services/${service.id}/score`)) return reply({ entries: [], can_manage: false });
      return reply(fixture(url));
    });
    render(<MemoryRouter><ProtocolPanel service={{ ...service, technician_id: "tech-1" }} onClose={() => {}} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Score" }));
    expect(await screen.findByText(/It has not received a passing score/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Pay & Growth" })).toHaveAttribute("href", "/tech/pay-growth");
  });
});
