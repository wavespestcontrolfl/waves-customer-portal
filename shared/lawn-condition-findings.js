'use strict';
const library = require('./lawn-condition-findings.json');
// Only catalog statements with controlled location/extent suffixes may egress.
const LAWN_STRUCTURED_OBSERVATIONS = new Set(library.groups.flatMap((group) =>
  group.findings.flatMap(({ statement }) => library.locations.flatMap((location) =>
    ['', ...library.extents].map((extent) => `${statement} Location: ${location}.${extent ? ` Extent: ${extent}.` : ''}`)))));
module.exports = { LAWN_STRUCTURED_OBSERVATIONS };
