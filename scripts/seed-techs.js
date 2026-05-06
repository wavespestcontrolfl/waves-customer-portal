#!/usr/bin/env node

/**
 * Retired legacy dispatch seed.
 *
 * This script used to seed the retired dispatch AI technician shadow table.
 * Canonical dispatch now reads technicians directly, so keeping
 * this as a writer would reintroduce split dispatch state in local/dev data.
 */

console.error([
  'scripts/seed-techs.js is retired.',
  'Canonical dispatch uses the technicians table directly.',
  'Create or update technicians through the admin/time-tracking technician flows instead.',
].join(' '));

process.exit(1);
