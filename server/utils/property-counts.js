// The per-lawn count an annual_max_apps cap is judged on: the busiest treated property's
// applications, plus every application that cannot be placed at a property (application-limits
// counts those at any property, since it cannot prove they happened elsewhere).
function worstPropertyCount(apps = []) {
  let unplaced = 0;
  const byProperty = new Map();
  for (const app of apps) {
    const property = app && app.treated_property_id;
    if (!property) unplaced += 1;
    else byProperty.set(String(property), (byProperty.get(String(property)) || 0) + 1);
  }
  return unplaced + Math.max(0, ...byProperty.values());
}

module.exports = { worstPropertyCount };
