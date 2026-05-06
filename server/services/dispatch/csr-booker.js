const { retired } = require('./retired');

const SCENARIOS = Object.freeze({
  urgent: { label: 'Urgent pest issue', urgency: 'high' },
  inspect: { label: 'Inspection / estimate', urgency: 'high' },
  lawn: { label: 'Recurring lawn treatment', urgency: 'normal' },
  callback: { label: 'Callback / retreat', urgency: 'high' },
  seasonal: { label: 'Seasonal add-on', urgency: 'low' },
});

module.exports = {
  getRecommendedSlots: retired('getRecommendedSlots'),
  SCENARIOS,
};
