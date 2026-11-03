// raiseAdminAlert for emitters that take an injected notifier (their tests, and a few hand-offs).
// Those emitters were written against notifyAdmin(category, title, body, opts). With no notifier
// this is raiseAdminAlert itself. With one, the alert is composed the same way and handed to that
// notifier in its old shape, so an injected stub or a pass-through still sees (category, title,
// body, opts). Injection is a test seam: a rule violation throws here, as it does in the test run.
const { composeAdminAlert } = require('./admin-alert-compose');

function raiserFor(notify) {
  if (typeof notify !== 'function') {
    return (category, spec, opts) => require('./admin-alert-compose').raiseAdminAlert(category, spec, opts);
  }
  return async (category, spec = {}, rawOpts = {}) => {
    const { fyiRow = false, ...opts } = rawOpts;
    const composed = composeAdminAlert(spec);
    if (spec.severity === 'fyi' && !fyiRow) return { id: null, suppressed: true, reason: 'fyi' };
    return notify(category, composed.headline, composed.why, {
      ...opts, link: composed.link, metadata: { ...(opts.metadata || {}), ...composed.metadata },
    });
  };
}

// For an emitter that sets refreshOnDedupe. A standing keyed row written before the emitter was converted
// has no metadata.area, and its title and body are in the old format. The first refresh onto the new format
// would count as changed content and ring a row the office already has. This rings on that refresh only
// when the OLD title, body or link would have changed too, so the conversion adds no ring. A row already in
// the new format keeps the default (every content change rings).
function ringOnRefreshAfterConversion({ title, body, link }) {
  return (existing, existingMeta) => {
    if (existingMeta && existingMeta.area) return true;
    return existing.title !== title || existing.body !== body || existing.link !== link;
  };
}

module.exports = { raiserFor, ringOnRefreshAfterConversion };
