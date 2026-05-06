const { retired } = require('./retired');

module.exports = {
  syncJobsFromSchedule: retired('syncJobsFromSchedule'),
  syncTechnicians: retired('syncTechnicians'),
};
