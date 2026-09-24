/**
 * Whether the active Pest Pressure config lets staff enter the technician
 * activity rating for a service line: `allowTechnicianClientRatingEntry` on,
 * and the line in `enabledServiceLines` (empty list = every line). Shared
 * by every staff rating writer — the completion form, the picker gate, and
 * the recap — so none of them bypasses the admin's switch.
 */
function pestPressureConfigAllowsTechnicianRating({ pestPressureConfig = null, serviceLine = null } = {}) {
  const techEntryAllowed = !!(pestPressureConfig
    && pestPressureConfig.allowTechnicianClientRatingEntry === true);
  const enabledLines = Array.isArray(pestPressureConfig && pestPressureConfig.enabledServiceLines)
    ? pestPressureConfig.enabledServiceLines
    : [];
  const serviceLineAllowed = enabledLines.length === 0
    || (serviceLine && enabledLines.includes(serviceLine));
  return techEntryAllowed && serviceLineAllowed;
}

module.exports = { pestPressureConfigAllowsTechnicianRating };
