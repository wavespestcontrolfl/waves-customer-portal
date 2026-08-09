/**
 * Service-line color map for calendar blocks.
 *
 * Client-side category detection mirrors server/utils/service-normalizer.js
 * detectServiceCategory(). Colors are restrained solid fills chosen to stay
 * within the admin monochrome feel while differentiating job types at a
 * glance in the mobile Square-style week view.
 *
 * Red (#C0392B) is reserved for alert states (overdue, unassigned, skipped) —
 * never used here as a service-line color.
 */

export const CATEGORY_COLORS = {
  pest:      { bg: '#1E40AF', fg: '#FFFFFF' }, // blue
  lawn:      { bg: '#166534', fg: '#FFFFFF' }, // green
  mosquito:  { bg: '#7C3AED', fg: '#FFFFFF' }, // purple
  termite:   { bg: '#92400E', fg: '#FFFFFF' }, // amber/brown
  rodent:    { bg: '#334155', fg: '#FFFFFF' }, // slate
  tree:      { bg: '#0E7490', fg: '#FFFFFF' }, // teal
  inspection:{ bg: '#52525B', fg: '#FFFFFF' }, // zinc
  default:   { bg: '#27272A', fg: '#FFFFFF' }, // near-black
};

export function detectServiceCategory(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  // Mirror server/utils/service-normalizer.js precedence (codex P2 #3038 r4):
  // tree & shrub names that also mention fertilization/weeds ("Tree & Shrub
  // Fertilization") are still tree & shrub — lawn wins only on an actual
  // lawn-surface token. Without this guard the /fertil|weed/ line below
  // classified those visits as lawn, diverging from the server.
  const treeToken = /tree|shrub|ornamental|palm|arborjet/.test(s);
  const lawnSurfaceToken = /lawn|turf|sod|dethatch|top\s*dress|aerat/.test(s);
  if (treeToken && !lawnSurfaceToken && !/mosquito|termite|wdo/.test(s)) return 'tree';
  if (/lawn|turf|fertil|weed|dethatch|aerat|sod|top\s*dress/.test(s)) return 'lawn';
  if (/mosquito/.test(s)) return 'mosquito';
  // Drill-and-foam termite forms only — "Foam Drill" / "Drill-and-Foam" /
  // "Recurring Foam Treatment (Quarterly)" / foam_drill / foam_recurring
  // carry no "termite" token of their own (mirrors the server normalizer).
  // NOT a bare 'foam' substring: foam sealant is rodent-exclusion material,
  // and "Rodent Exclusion — Foam Sealing" must reach the rodent branch.
  if (/termite|wdo|bora|termidor|trelona|foam[\s_-]*drill|drill[\s_&-]*(?:and[\s_-]*)?foam|recurring[\s_-]*foam|foam[\s_-]*recurring/.test(s)) return 'termite';
  // bird box / roof-entry: rodent-exclusion hardware with no rodent token
  // in the catalog name (mirrors the server normalizer).
  if (/rodent|rat|mouse|mice|bird\s*box|roof-entry|trap[\s_-]*only/.test(s)) return 'rodent';
  if (/tree|shrub|palm|arborjet|ornamental/.test(s)) return 'tree';
  if (/inspect|assessment|consultation|estimat/.test(s)) return 'inspection';
  return 'pest';
}

export function serviceColor(serviceType) {
  return CATEGORY_COLORS[detectServiceCategory(serviceType)] || CATEGORY_COLORS.default;
}
