/**
 * Per-frequency pre-checked add-on defaults for the estimate view.
 *
 * Product heuristic, not per-estimate data — so we keep it out of the
 * schema. Edit this file to change defaults; no route or component
 * changes needed.
 *
 * Keys match the JSON data endpoint's frequency keys
 * (one_time / quarterly / bi_monthly / monthly). Values are add-on
 * keys — must match whatever the estimate's pricing surface calls
 * each add-on (see lineItem.key or the checklist item key).
 *
 * Edit with Virginia's input after UAT if defaults feel wrong.
 */
module.exports = {
  one_time: [],
  quarterly: [],
  bi_monthly: ['inside_spray'],
  monthly: ['inside_spray'],
};
