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
  if (/lawn|fertil|weed|dethatch|aerat|sod|top\s*dress/.test(s)) return 'lawn';
  if (/mosquito/.test(s)) return 'mosquito';
  if (/termite|wdo|bora|termidor|trelona/.test(s)) return 'termite';
  if (/rodent|rat|mouse|mice/.test(s)) return 'rodent';
  if (/tree|shrub|palm|arborjet/.test(s)) return 'tree';
  if (/inspect|assessment|consultation|estimat/.test(s)) return 'inspection';
  return 'pest';
}

export function serviceColor(serviceType) {
  return CATEGORY_COLORS[detectServiceCategory(serviceType)] || CATEGORY_COLORS.default;
}
