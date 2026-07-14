// Staff API responses may describe whether a call recording exists and expose
// its opaque database/Twilio SID, but the provider URL is an internal fetch
// detail. The only browser retrieval path is the Bearer-authenticated audio
// proxy in admin-call-recordings.js.

const PRIVACY_INSTALLED = Symbol('staffCallRecordingPrivacyInstalled');

const RECORDING_URL_FIELDS = new Map([
  ['recording_url', 'recording_available'],
  ['call_recording_url', 'call_recording_available'],
  ['recordingUrl', 'recordingAvailable'],
]);

function redactStaffCallRecordingUrls(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry) => redactStaffCallRecordingUrls(entry, seen));
    return value;
  }

  // Unified-comms recording media is the one place the sensitive URL uses the
  // generic key `url`. Only touch objects explicitly typed as recordings so
  // image/video/document links retain their existing response semantics.
  if (value.type === 'recording') {
    const available = Boolean(value.available || value.url || value.sid);
    delete value.url;
    value.available = available;
  }

  for (const [urlField, availabilityField] of RECORDING_URL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, urlField)) continue;
    const available = Boolean(value[urlField]);
    delete value[urlField];
    value[availabilityField] = Boolean(value[availabilityField] || available);
  }

  Object.values(value).forEach((entry) => redactStaffCallRecordingUrls(entry, seen));
  return value;
}

function installStaffCallRecordingPrivacy(res) {
  if (!res || typeof res.json !== 'function' || res[PRIVACY_INSTALLED]) return;
  const json = res.json.bind(res);
  Object.defineProperty(res, PRIVACY_INSTALLED, { value: true });
  res.json = (body) => json(redactStaffCallRecordingUrls(body));
}

module.exports = {
  installStaffCallRecordingPrivacy,
  redactStaffCallRecordingUrls,
};
