// The per-lawn figure a yearly cap is judged on: the busiest treated property's total, plus every
// application that cannot be placed at a property (application-limits counts those at any property,
// since it cannot prove they happened elsewhere). `weight` sizes one application (default 1: a count).
function worstPropertyTotal(apps = [], weight = () => 1) {
  let unplaced = 0;
  const byProperty = new Map();
  for (const app of apps) {
    const property = app && app.treated_property_id;
    const size = Number(weight(app)) || 0;
    if (!property) unplaced += size;
    else byProperty.set(String(property), (byProperty.get(String(property)) || 0) + size);
  }
  return unplaced + Math.max(0, ...byProperty.values());
}

// The per-lawn count an annual_max_apps cap is judged on.
const worstPropertyCount = (apps = []) => worstPropertyTotal(apps);

module.exports = { worstPropertyCount, worstPropertyTotal };
