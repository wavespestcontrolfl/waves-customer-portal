import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_DESKTOP_NAV_SECTIONS,
  ADMIN_MOBILE_MORE_SECTIONS,
  ADMIN_MOBILE_TABS,
  ADMIN_NAV_ITEMS,
  isAdminNavItemActive,
} from "./adminNavigation";

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
      {
        section: "Operations",
        itemIds: [
          "schedule",
          "jobs",
          "assessments",
          "services",
          "equipment",
          "turfHeight",
          "inventory",
          "priceMatch",
        ],
      },
      {
        section: "Customers & Sales",
        itemIds: [
          "customers",
          "pipeline",
          "communications",
          "contracts",
          "reviews",
          "referrals",
        ],
      },
      {
        section: "Marketing",
        itemIds: ["email", "ppc", "seo", "social", "blog", "newsletter"],
      },
      { section: "Team & Automation", itemIds: ["staff", "agents"] },
      {
        section: "Billing & Finance",
        itemIds: [
          "invoices",
          "recovery",
          "payers",
          "banking",
          "taxes",
          "pricing",
          "priceNotices",
        ],
      },
      { section: "Resources", itemIds: ["wiki", "knowledgeBase"] },
      {
        section: "Administration",
        itemIds: ["compliance", "toolHealth", "settings"],
      },
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
      { id: "more", path: "/admin/more", label: "More" },
    ]);
  });

  it("gives desktop and mobile access to the same destinations", () => {
    const desktopIds = sectionItems(ADMIN_DESKTOP_NAV_SECTIONS).map(({ id }) => id);
    const mobileIds = [
      ...ADMIN_MOBILE_TABS.filter(({ id }) => id !== "more").map(({ id }) => id),
      ...sectionItems(ADMIN_MOBILE_MORE_SECTIONS).map(({ id }) => id),
    ];

    expect(new Set(mobileIds)).toEqual(new Set(desktopIds));
    expect(desktopIds).toContain("turfHeight");
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
    expect(ADMIN_NAV_ITEMS.wiki.label).toBe("Wiki");
    expect(ADMIN_NAV_ITEMS.knowledgeBase.label).toBe("Knowledge Base");
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

  it("does not mark unrelated or non-schedule dispatch views active", () => {
    expect(
      isAdminNavItemActive(
        ADMIN_NAV_ITEMS.schedule,
        "/admin/dispatch",
        "?tab=board",
      ),
    ).toBe(false);
    expect(isAdminNavItemActive(ADMIN_NAV_ITEMS.customers, "/admin/customer"))
      .toBe(false);
  });
});
