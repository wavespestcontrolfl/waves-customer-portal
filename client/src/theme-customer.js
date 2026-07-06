// Customer-surface warm palette — single source of truth.
//
// Before 2026-07-06 these hexes were copy-pasted as local ESTIMATE_* /
// PORTAL_SHELL / PORTAL_BILLING consts in PortalPage, EstimateViewPage,
// ReportViewPage, ProjectReportViewPage, and AutopayCard — five drifting
// copies (two had muted at gray-500 #6B7280 instead of the portal's
// slate-600 #475569). Customer pages keep their local aliases but source
// the values here.
//
// This is the WARM customer system (estimate/report/portal). It is
// deliberately separate from the admin monochrome-V2 system (components/ui
// + zinc) and from theme-brand.js's marketing-site .btn tokens — do not
// merge them.

export const CUSTOMER_SURFACE = {
  page: '#FAF8F3',          // warm page background
  surface: '#FFFFFF',       // cards
  chrome: '#F7F5EE',        // header/chrome wash (estimate)
  border: '#E7E2D7',        // hairline card border
  borderStrong: '#D8D0C0',  // inputs, emphasized dividers
  text: '#1B2C5B',          // brand navy — headings/emphasis
  body: '#3F4A65',          // body copy
  muted: '#475569',         // supporting text (slate-600; the one blessed gray)
  soft: '#F8FCFE',          // soft blue wash (inputs, selected fills)
  softBorder: '#CFE7F5',    // soft blue border
  successBg: '#F0FDF4',
  successBorder: '#BBF7D0',
  successText: '#047857',
};

// Shared business contact constants (previously re-declared per page).
export const WAVES_PHONE_DISPLAY = '(941) 297-5749';
export const WAVES_PHONE_TEL = '+19412975749';
