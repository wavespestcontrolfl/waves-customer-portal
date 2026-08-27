// Mobile settings index — the leaves the mobile Settings surface lists
// (/admin/more, the fifth tab). Shared navigation DATA, kept beside
// adminNavigation.js so the tab's active-state ownership, the page that
// renders the list, and the legacy MobileSettingsPage all read one source.
// Standalone destinations (Invoices, Banking, Communications) also exist as
// nav rows; ?tab= entries deep-link into SettingsPage tabs.
export const MOBILE_SETTINGS_SECTIONS = [
  { key: "invoices", label: "Invoices", to: "/admin/invoices", adminOnly: true },
  { key: "payments", label: "Payments", to: "/admin/banking", adminOnly: true },
  {
    key: "tap-to-pay",
    label: "Tap to Pay",
    to: "/admin/settings?tab=integrations",
    // IntegrationsTab renders "Admin access required" for other roles.
    adminOnly: true,
  },
  {
    key: "communications",
    label: "Communications",
    to: "/admin/communications",
  },
  { key: "team", label: "Team", to: "/admin/settings?tab=team" },
  {
    key: "service-reports",
    label: "Service Reports",
    to: "/admin/settings?tab=service-reports",
    adminOnly: true,
  },
  {
    key: "blackout-days",
    label: "Blackout Days",
    to: "/admin/settings?tab=blackout-days",
    adminOnly: true,
  },
  {
    key: "kpi-targets",
    label: "KPI Targets",
    to: "/admin/settings?tab=kpi-targets",
    adminOnly: true,
  },
  {
    key: "integrations",
    label: "Integrations",
    to: "/admin/settings?tab=integrations",
    adminOnly: true,
  },
  { key: "account", label: "Account", to: "/admin/settings?tab=general" },
  { key: "system", label: "System", to: "/admin/settings?tab=system", adminOnly: true },
  { key: "usage", label: "Portal Usage", to: "/admin/settings?tab=usage" },
  {
    key: "feature-flags",
    label: "Early feature access",
    to: "/admin/_design-system/flags",
    adminOnly: true,
  },
];
