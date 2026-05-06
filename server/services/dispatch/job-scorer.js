const { retired, retiredSync } = require('./retired');

module.exports = {
  scoreJob: retired('scoreJob'),
  scoreAll: retired('scoreAll'),
  ruleBasedScore: retiredSync('ruleBasedScore'),
  driveMins: retiredSync('driveMins'),
};
