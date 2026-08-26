import {
  Activity,
  Banknote,
  BookMarked,
  BookOpen,
  Building2,
  Calculator,
  Calendar,
  Camera,
  ClipboardList,
  Clock,
  FileText,
  Gift,
  Home,
  Landmark,
  LayoutDashboard,
  Mail,
  Megaphone,
  Menu,
  MessageSquare,
  Newspaper,
  Package,
  Receipt,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Star,
  Tags,
  Users,
  Wrench,
  Bot,
} from "lucide-react";

// Canonical metadata for every destination currently rendered by the admin
// shell. The desktop sidebar and mobile More page are derived from the same
// taxonomy so a destination cannot silently disappear from one surface.
//
// `adminOnly: true` scopes a destination to role === 'admin' (the owner).
// A technician-role login keeps only the day-to-day service surfaces:
// dashboard, schedule, reports, customers, communications, assessments,
// staff time-tracking, equipment, inventory, knowledge, settings. Sales,
// marketing, finance, and system destinations are owner-only. The sidebar,
// More page, and the shell's deep-link guard (isPathAdminOnly) all read
// this flag — UI scoping only; the API's requireAdmin/requireTechOrAdmin
// middleware stays the enforcement boundary.
export const ADMIN_NAV_ITEMS = {
  dashboard: {
    id: "dashboard",
    path: "/admin/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    mobileTabIcon: Home,
  },
  customers: {
    id: "customers",
    path: "/admin/customers",
    label: "Customers",
    icon: Users,
  },
  pipeline: {
    id: "pipeline",
    path: "/admin/pipeline",
    label: "Pipeline",
    icon: ClipboardList,
    adminOnly: true,
  },
  schedule: {
    id: "schedule",
    path: "/admin/schedule",
    label: "Schedule",
    icon: Calendar,
  },
  staff: {
    id: "staff",
    path: "/admin/timetracking",
    label: "Staff",
    icon: Clock,
  },
  services: {
    id: "services",
    path: "/admin/service-library",
    label: "Services",
    icon: BookOpen,
    adminOnly: true,
  },
  jobs: {
    id: "jobs",
    path: "/admin/projects",
    label: "Reports",
    icon: FileText,
  },
  contracts: {
    id: "contracts",
    path: "/admin/contracts",
    label: "Contracts",
    icon: FileText,
    // server/routes/admin-contracts.js is requireAdmin on every endpoint.
    adminOnly: true,
  },
  communications: {
    id: "communications",
    path: "/admin/communications",
    label: "Communications",
    icon: MessageSquare,
    mobileTabLabel: "Messages",
  },
  reviews: {
    id: "reviews",
    path: "/admin/reviews",
    label: "Reviews",
    icon: Star,
    adminOnly: true,
  },
  referrals: {
    id: "referrals",
    path: "/admin/referrals",
    label: "Referrals",
    icon: Gift,
    adminOnly: true,
  },
  email: {
    id: "email",
    path: "/admin/email",
    label: "Email",
    icon: Mail,
    adminOnly: true,
  },
  ppc: {
    id: "ppc",
    path: "/admin/ppc",
    label: "PPC",
    icon: Megaphone,
    adminOnly: true,
  },
  seo: {
    id: "seo",
    path: "/admin/seo",
    label: "SEO",
    icon: Search,
    adminOnly: true,
  },
  social: {
    id: "social",
    path: "/admin/social-media",
    label: "Social Media",
    icon: Share2,
    adminOnly: true,
  },
  blog: {
    id: "blog",
    path: "/admin/blog",
    label: "Blog",
    icon: Newspaper,
    adminOnly: true,
  },
  newsletter: {
    id: "newsletter",
    path: "/admin/newsletter",
    label: "Newsletter",
    icon: Send,
    adminOnly: true,
  },
  assessments: {
    id: "assessments",
    path: "/admin/lawn-assessments",
    label: "Assessments",
    icon: Camera,
    morePath: "/admin/lawn-assessments?tab=field",
  },
  agents: {
    id: "agents",
    path: "/admin/agents",
    label: "Agent Ops",
    icon: Bot,
    adminOnly: true,
  },
  agentEstimate: {
    id: "agentEstimate",
    path: "/admin/agent-estimate",
    label: "Agent Estimate",
    icon: Sparkles,
    flag: "agent_estimate",
    adminOnly: true,
  },
  equipment: {
    id: "equipment",
    path: "/admin/equipment",
    label: "Equipment",
    icon: Wrench,
  },
  inventory: {
    id: "inventory",
    path: "/admin/inventory",
    label: "Inventory",
    icon: Package,
  },
  priceMatch: {
    id: "priceMatch",
    path: "/admin/price-match",
    label: "Price Match",
    icon: Tags,
    adminOnly: true,
  },
  compliance: {
    id: "compliance",
    path: "/admin/compliance",
    label: "Compliance",
    icon: ShieldCheck,
    adminOnly: true,
  },
  knowledge: {
    id: "knowledge",
    path: "/admin/knowledge",
    label: "Knowledge",
    icon: BookMarked,
  },
  invoices: {
    id: "invoices",
    path: "/admin/invoices",
    label: "Invoices",
    icon: FileText,
    adminOnly: true,
  },
  recovery: {
    id: "recovery",
    path: "/admin/billing-recovery",
    label: "Recovery",
    icon: Banknote,
    adminOnly: true,
  },
  payers: {
    id: "payers",
    path: "/admin/payers",
    label: "Payers",
    icon: Building2,
    // server/routes/admin-payers.js is requireAdmin on every endpoint.
    adminOnly: true,
  },
  banking: {
    id: "banking",
    path: "/admin/banking",
    label: "Banking",
    icon: Landmark,
    adminOnly: true,
  },
  taxes: {
    id: "taxes",
    path: "/admin/tax",
    label: "Taxes",
    icon: Receipt,
    adminOnly: true,
  },
  pricing: {
    id: "pricing",
    path: "/admin/pricing-logic",
    label: "Pricing",
    icon: Calculator,
    adminOnly: true,
  },
  toolHealth: {
    id: "toolHealth",
    path: "/admin/tool-health",
    label: "Tool Health",
    icon: Activity,
    adminOnly: true,
  },
  settings: {
    id: "settings",
    path: "/admin/settings",
    label: "Settings",
    icon: Settings,
  },
  more: {
    id: "more",
    path: "/admin/more",
    label: "More",
    icon: Menu,
  },
};

const NAV_SECTION_DEFINITIONS = [
  { section: "Overview", itemIds: ["dashboard"] },
  {
    section: "Operations",
    itemIds: [
      "schedule",
      "jobs",
      "assessments",
      "services",
      "equipment",
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
  { section: "Team & Automation", itemIds: ["staff", "agents", "agentEstimate"] },
  {
    section: "Billing & Finance",
    itemIds: [
      "invoices",
      "recovery",
      "payers",
      "banking",
      "taxes",
      "pricing",
    ],
  },
  { section: "Resources", itemIds: ["knowledge"] },
  {
    section: "Administration",
    itemIds: ["compliance", "toolHealth", "settings"],
  },
];

const MOBILE_TAB_IDS = [
  "dashboard",
  "schedule",
  "customers",
  "communications",
  "more",
];

const MOBILE_TAB_ID_SET = new Set(MOBILE_TAB_IDS);

const MOBILE_MORE_SECTION_DEFINITIONS = NAV_SECTION_DEFINITIONS.map(
  ({ section, itemIds }) => ({
    section,
    itemIds: itemIds.filter((itemId) => !MOBILE_TAB_ID_SET.has(itemId)),
  }),
).filter(({ itemIds }) => itemIds.length > 0);

function materializeItem(itemId, surface) {
  const item = ADMIN_NAV_ITEMS[itemId];
  if (!item) throw new Error(`Unknown admin navigation item: ${itemId}`);
  return {
    id: item.id,
    path: surface === "more" && item.morePath ? item.morePath : item.path,
    label:
      surface === "mobileTab" && item.mobileTabLabel
        ? item.mobileTabLabel
        : item.label,
    icon:
      surface === "mobileTab" && item.mobileTabIcon
        ? item.mobileTabIcon
        : item.icon,
    adminOnly: Boolean(item.adminOnly),
    flag: item.flag || null,
  };
}

function materializeSections(definitions, surface) {
  return definitions.map(({ section, itemIds }) => ({
    section,
    items: itemIds.map((itemId) => materializeItem(itemId, surface)),
  }));
}

export const ADMIN_DESKTOP_NAV_SECTIONS = materializeSections(
  NAV_SECTION_DEFINITIONS,
  "desktop",
);

export const ADMIN_MOBILE_MORE_SECTIONS = materializeSections(
  MOBILE_MORE_SECTION_DEFINITIONS,
  "more",
);

export const ADMIN_MOBILE_TABS = MOBILE_TAB_IDS.map((itemId) =>
  materializeItem(itemId, "mobileTab"),
);

function pathnameFor(path) {
  return String(path || "").split("?")[0];
}

// Deep-link guard: nav filtering alone is not a boundary — a non-admin can
// still type /admin/banking. The shell redirects any pathname that belongs
// to an adminOnly destination (exact or nested). Unknown paths return false
// (the API's role middleware is the real enforcement).
export function isPathAdminOnly(pathname) {
  const p = String(pathname || "");
  return Object.values(ADMIN_NAV_ITEMS).some((item) => {
    if (!item.adminOnly) return false;
    const itemPathname = pathnameFor(item.path);
    return p === itemPathname || p.startsWith(`${itemPathname}/`);
  });
}

export function isAdminNavItemActive(item, pathname, search = "") {
  const itemPathname = pathnameFor(item?.path);
  if (!itemPathname) return false;
  if (pathname === itemPathname) return true;
  if (item.id === "dashboard" && pathname === "/admin") return true;
  if (item.id === "schedule" && pathname === "/admin/dispatch") {
    return true;
  }
  if (item.id === "more") {
    return ADMIN_MOBILE_MORE_SECTIONS.some(({ items }) =>
      items.some((moreItem) => {
        const morePathname = pathnameFor(moreItem.path);
        return (
          pathname === morePathname || pathname.startsWith(`${morePathname}/`)
        );
      }),
    );
  }
  return pathname.startsWith(`${itemPathname}/`);
}
