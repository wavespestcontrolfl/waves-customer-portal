import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_DESKTOP_NAV_SECTIONS,
  ADMIN_MOBILE_MORE_SECTIONS,
  ADMIN_MOBILE_TABS,
  ADMIN_NAV_ITEMS,
  isAdminNavItemActive,
  isPathAdminOnly,
  getAdminWorkspaceGroups,
  getAdminWorkspaceSelection,
  searchAdminWorkspacePages,
} from "./adminNavigation";

describe("grouped workspaces", () => {
  it('finds renamed pages by old names and workspace terms without widening access', () => {
    const admin = getAdminWorkspaceGroups('admin');
    for (const [query, id] of [['Recovery', 'recovery'], ['Payers', 'payers'], ['Taxes', 'taxes'], ['Tool Health', 'toolHealth'], ['dispatch', 'schedule'], ['Reports', 'jobs']]) {
      expect(searchAdminWorkspacePages(admin, query).map((item) => item.id)).toContain(id);
    }
    expect(searchAdminWorkspacePages(admin, 'accounting').map((item) => item.id)).toEqual(['banking', 'taxes']);
    const tech = getAdminWorkspaceGroups('technician', { agent_estimate: true });
    expect(searchAdminWorkspacePages(tech, 'Sales')).toEqual([]);
    expect(searchAdminWorkspacePages(tech, 'Contracts')).toEqual([]);
    expect(searchAdminWorkspacePages(admin, 'Agent estimate')).toEqual([]);
  });
  it("keeps every canonical destination exactly once, plus the existing Estimates subview", () => {
    const groups = getAdminWorkspaceGroups('admin', { agent_estimate: true });
    const ids = groups.flatMap(({ items }) => items.map(({ id }) => id));
    expect(groups).toHaveLength(12);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(new Set(ids)).toEqual(new Set([...Object.keys(ADMIN_NAV_ITEMS).filter((id) => id !== 'more'), 'estimates']));
  });

  it("applies leaf roles and gates even beneath accessible parents", () => {
    expect(getAdminWorkspaceGroups(null)).toEqual([]);
    const techIds = getAdminWorkspaceGroups('technician', { agent_estimate: true }).flatMap(({ items }) => items.map(({ id }) => id));
    expect(new Set(techIds)).toEqual(new Set(Object.values(ADMIN_NAV_ITEMS).filter((item) => !item.adminOnly && item.id !== 'more').map(({ id }) => id)));
    const adminIds = getAdminWorkspaceGroups('admin').flatMap(({ items }) => items.map(({ id }) => id));
    expect(adminIds).not.toContain('agentEstimate');
    expect(techIds).not.toEqual(expect.arrayContaining(['contracts', 'toolHealth', 'estimates']));
  });

  it("resolves actual rendered tabs, proposal links, and redirected Schedule", () => {
    const location = { pathname: '/admin/pipeline', search: '' };
    expect(getAdminWorkspaceSelection(location, { pathname: location.pathname, tab: 'estimates' })).toEqual({ groupId: 'sales', itemId: 'estimates' });
    expect(getAdminWorkspaceSelection(location, { pathname: location.pathname, tab: 'new' })).toEqual({ groupId: 'sales', itemId: null });
    expect(getAdminWorkspaceSelection({ pathname: '/admin/estimates/fixture/proposal' }).itemId).toBe('estimates');
    expect(getAdminWorkspaceSelection({ pathname: '/admin/dispatch', search: '?tab=schedule' }).itemId).toBe('schedule');
  });
});

function compactSections(sections) {
  return sections.map(({ section, items }) => ({
    section,
    itemIds: items.map(({ id }) => id),
  }));
}

function sectionItems(sections) {
  return sections.flatMap(({ items }) => items);
}

describe("admin navigation registry", () => {
  it("uses the consolidated admin taxonomy", () => {
    expect(compactSections(ADMIN_DESKTOP_NAV_SECTIONS)).toEqual([
      { section: "Overview", itemIds: ["dashboard"] },
      { section: "Service operations", itemIds: ["schedule", "jobs", "assessments", "services", "pricing", "equipment", "inventory", "compliance", "knowledge"] },
      { section: "Customers & Sales", itemIds: ["customers", "pipeline", "agentEstimate", "priceMatch", "contracts"] },
      { section: "Communications", itemIds: ["communications"] },
      { section: "Billing & Finance", itemIds: ["invoices", "recovery", "payers", "banking", "taxes"] },
      { section: "People", itemIds: ["staff", "recruiting"] },
      { section: "Marketing", itemIds: ["ppc", "seo", "social", "blog", "newsletter", "reviews", "referrals"] },
      { section: "System", itemIds: ["agents", "toolHealth", "settings"] },
    ]);
  });

  it("keeps the five task-focused mobile tabs", () => {
    expect(
      ADMIN_MOBILE_TABS.map(({ id, path, label }) => ({ id, path, label })),
    ).toEqual([
      { id: "dashboard", path: "/admin/dashboard", label: "Dashboard" },
      { id: "schedule", path: "/admin/schedule", label: "Schedule" },
      { id: "customers", path: "/admin/customers", label: "Customers" },
      {
        id: "communications",
        path: "/admin/communications",
        label: "Messages",
      },
      { id: "more", path: "/admin/more", label: "Settings" },
    ]);
  });

  it("gives desktop and mobile access to the same destinations", () => {
    const desktopIds = sectionItems(ADMIN_DESKTOP_NAV_SECTIONS).map(({ id }) => id);
    const mobileIds = [
      ...ADMIN_MOBILE_TABS.filter(({ id }) => id !== "more").map(({ id }) => id),
      ...sectionItems(ADMIN_MOBILE_MORE_SECTIONS).map(({ id }) => id),
      // The Settings tab page renders the Settings leaves inline (not as a
      // nav row) — that IS the mobile route to the `settings` destination.
      "settings",
    ];
    expect(sectionItems(ADMIN_MOBILE_MORE_SECTIONS).map(({ id }) => id)).not.toContain("settings");

    expect(new Set(mobileIds)).toEqual(new Set(desktopIds));
    expect(mobileIds).toEqual(expect.arrayContaining(["jobs", "contracts", "payers"]));
  });

  it("uses canonical labels and routes on both navigation surfaces", () => {
    const desktopItems = sectionItems(ADMIN_DESKTOP_NAV_SECTIONS);
    const moreItems = sectionItems(ADMIN_MOBILE_MORE_SECTIONS);

    for (const item of [...desktopItems, ...moreItems]) {
      expect(item.label).toBe(ADMIN_NAV_ITEMS[item.id].label);
      if (item.id === "assessments" && moreItems.includes(item)) {
        expect(item.path).toBe("/admin/lawn-assessments?tab=field");
      } else {
        expect(item.path).toBe(ADMIN_NAV_ITEMS[item.id].path);
      }
    }

    expect(ADMIN_NAV_ITEMS.communications.label).toBe("Communications");
    expect(ADMIN_NAV_ITEMS.knowledge.label).toBe("Knowledge");
    expect(ADMIN_NAV_ITEMS.knowledge.path).toBe("/admin/knowledge");
    expect(ADMIN_NAV_ITEMS.pricing.path).toBe("/admin/pricing-logic");
    expect(ADMIN_NAV_ITEMS.jobs.label).toBe("Reports");
    expect(ADMIN_NAV_ITEMS.jobs.path).toBe("/admin/projects");
    expect(ADMIN_NAV_ITEMS.turfHeight).toBeUndefined();
    expect(ADMIN_NAV_ITEMS.priceNotices).toBeUndefined();
  });

  it("renders every destination exactly once per navigation surface", () => {
    const desktopIds = sectionItems(ADMIN_DESKTOP_NAV_SECTIONS).map(({ id }) => id);
    const moreIds = sectionItems(ADMIN_MOBILE_MORE_SECTIONS).map(({ id }) => id);
    const canonicalDestinationIds = Object.keys(ADMIN_NAV_ITEMS).filter(
      (id) => id !== "more",
    );

    expect(new Set(desktopIds).size).toBe(desktopIds.length);
    expect(new Set(moreIds).size).toBe(moreIds.length);
    expect(new Set(desktopIds)).toEqual(new Set(canonicalDestinationIds));
    expect(
      Object.values(ADMIN_NAV_ITEMS).every(({ id, path, label, icon }) =>
        Boolean(id && path && label && icon),
      ),
    ).toBe(true);
  });

  it("only links to mounted admin routes", () => {
    const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const mountedPaths = new Set(
      [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]),
    );

    for (const item of Object.values(ADMIN_NAV_ITEMS)) {
      const pathname = new URL(item.path, "https://admin.test").pathname;
      const nestedPath = pathname.replace(/^\/admin\/?/, "");
      expect(mountedPaths, `${item.label} points to an unmounted route`).toContain(
        nestedPath,
      );
    }
  });

  it("keeps the turf-height review route mounted for OCR triage", () => {
    // TurfHeightReviewPage is the only client consumer of the
    // review/resolve endpoints in server/routes/admin-turf-height.js —
    // the route must stay mounted (off-nav) until that workflow has a
    // real home in Schedule.
    const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

    expect(appSource).toContain('<Route path="turf-height"');
    expect(appSource).toContain("TurfHeightReviewPage");
    expect(appSource).not.toContain(
      '<Route path="turf-height" element={<Navigate',
    );
  });
});

describe("isAdminNavItemActive", () => {
  it("matches canonical, nested, and compatibility destinations", () => {
    expect(isAdminNavItemActive(ADMIN_NAV_ITEMS.dashboard, "/admin")).toBe(true);
    expect(
      isAdminNavItemActive(ADMIN_NAV_ITEMS.customers, "/admin/customers/duplicates"),
    ).toBe(true);
    expect(
      isAdminNavItemActive(
        ADMIN_NAV_ITEMS.schedule,
        "/admin/dispatch",
        "?tab=schedule",
      ),
    ).toBe(true);
  });

  it("keeps the Settings tab active on the Settings leaves it lists inline", () => {
    const more = ADMIN_MOBILE_TABS.find(({ id }) => id === "more");
    expect(isAdminNavItemActive(more, "/admin/more")).toBe(true);
    expect(isAdminNavItemActive(more, "/admin/settings", "?tab=team")).toBe(true);
    expect(isAdminNavItemActive(more, "/admin/settings/pest-pressure")).toBe(true);
    expect(isAdminNavItemActive(more, "/admin/_design-system/flags")).toBe(true); // standalone inline leaf
    expect(isAdminNavItemActive(more, "/admin/invoices")).toBe(true); // a nav row
    expect(isAdminNavItemActive(more, "/admin/customers")).toBe(false); // another tab
  });

  it("keeps Schedule active across its dispatch workspace", () => {
    expect(
      isAdminNavItemActive(
        ADMIN_NAV_ITEMS.schedule,
        "/admin/dispatch",
        "?tab=board",
      ),
    ).toBe(true);
    expect(
      isAdminNavItemActive(
        ADMIN_NAV_ITEMS.schedule,
        "/admin/dispatch",
        "?tab=automation",
      ),
    ).toBe(true);
    expect(isAdminNavItemActive(ADMIN_NAV_ITEMS.customers, "/admin/customer"))
      .toBe(false);
  });

  it("keeps More active while viewing a secondary mobile destination", () => {
    for (const pathname of [
      "/admin/projects",
      "/admin/pipeline",
      "/admin/lawn-assessments",
      "/admin/tool-health",
    ]) {
      expect(isAdminNavItemActive(ADMIN_NAV_ITEMS.more, pathname)).toBe(true);
    }

    for (const pathname of [
      "/admin/dashboard",
      "/admin/dispatch",
      "/admin/customers",
      "/admin/communications",
    ]) {
      expect(isAdminNavItemActive(ADMIN_NAV_ITEMS.more, pathname)).toBe(false);
    }
  });
});

describe("role scoping (adminOnly)", () => {
  // The technician-role day-to-day surface. Changing this set is a product
  // decision — update deliberately, with the owner's sign-off.
  const TECH_VISIBLE_IDS = [
    "schedule",
    "staff",
    "jobs",
    "communications",
    "customers",
    "assessments",
    "equipment",
    "inventory",
    "knowledge",
    "settings",
    "more",
  ];

  it("scopes every destination outside the day-to-day set to admin", () => {
    const techVisible = Object.values(ADMIN_NAV_ITEMS)
      .filter((item) => !item.adminOnly)
      .map(({ id }) => id);
    expect(new Set(techVisible)).toEqual(new Set(TECH_VISIBLE_IDS));
  });

  it("flags owner-only deep links, including nested and non-nav paths", () => {
    expect(isPathAdminOnly("/admin/banking")).toBe(true);
    expect(isPathAdminOnly("/admin/invoices/123")).toBe(true);
    expect(isPathAdminOnly("/admin/seo")).toBe(true);
    expect(isPathAdminOnly("/admin/pricing-logic")).toBe(true);
    // Routes absent from the nav taxonomy are still owner-only (codex P1).
    expect(isPathAdminOnly("/admin/estimates/est-1/proposal")).toBe(true);
    expect(isPathAdminOnly("/admin/_design-system")).toBe(true);
    expect(isPathAdminOnly("/admin/leads")).toBe(true);
    expect(isPathAdminOnly("/admin/credentials")).toBe(true);
    expect(isPathAdminOnly("/admin/revenue")).toBe(true);
    // Default-deny: unknown/future routes are owner-only until allowlisted.
    expect(isPathAdminOnly("/admin/not-a-page")).toBe(true);
    // Owner-only pages nested under technician-allowed prefixes (codex P1).
    expect(isPathAdminOnly("/admin/customers/duplicates")).toBe(true);
    expect(isPathAdminOnly("/admin/settings/pest-pressure")).toBe(true);

    expect(isPathAdminOnly("/admin")).toBe(false);
    // Dashboard's API is requireAdmin — owner-only despite being a mobile tab.
    expect(isPathAdminOnly("/admin/dashboard")).toBe(true);
    expect(isPathAdminOnly("/admin/schedule")).toBe(false);
    expect(isPathAdminOnly("/admin/dispatch")).toBe(false);
    expect(isPathAdminOnly("/admin/customers/abc")).toBe(false);
    expect(isPathAdminOnly("/admin/knowledge")).toBe(false);
    expect(isPathAdminOnly("/admin/settings")).toBe(false);
  });

  it("keeps every technician-visible nav destination reachable past the guard", () => {
    for (const item of Object.values(ADMIN_NAV_ITEMS)) {
      if (item.adminOnly || item.id === "more") continue;
      const pathname = item.path.split("?")[0];
      expect({ id: item.id, blocked: isPathAdminOnly(pathname) }).toEqual({
        id: item.id,
        blocked: false,
      });
    }
  });
});
