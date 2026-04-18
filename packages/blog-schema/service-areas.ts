// Valid values for `service_areas_tag` frontmatter field.
//
// Decoupled from schema.ts so expansion into new markets doesn't require
// a schema version bump — bump this file, run `npm run generate:blog-schema`,
// and the generated schema.json picks up the new values as enum members.
//
// Both files (schema.ts + service-areas.ts) are hashed into checksum.txt,
// so the admin vendor drift check still fires if either file changes.

export const SERVICE_AREAS = [
  'Bradenton',
  'Lakewood Ranch',
  'Sarasota',
  'Venice',
  'North Port',
  'Palmetto',
  'Parrish',
  'Port Charlotte',
] as const;

export type ServiceArea = (typeof SERVICE_AREAS)[number];
