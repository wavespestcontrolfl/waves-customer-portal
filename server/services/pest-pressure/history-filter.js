function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function serviceRecordSuppressesCustomerArtifacts(record = {}) {
  const notes = parseJsonObject(record.structured_notes);
  return Boolean(notes.typedReportDelivery) && notes.typedReportDelivery !== 'auto_send';
}

function customerVisibleServiceRecordPredicate(alias = 'service_records') {
  const column = alias ? `${alias}.structured_notes` : 'structured_notes';
  return `COALESCE(${column}->>'typedReportDelivery', 'auto_send') = 'auto_send'`;
}

function applyCustomerVisibleServiceRecordFilter(query, { alias = 'service_records' } = {}) {
  return query.whereRaw(customerVisibleServiceRecordPredicate(alias));
}

module.exports = {
  parseJsonObject,
  serviceRecordSuppressesCustomerArtifacts,
  customerVisibleServiceRecordPredicate,
  applyCustomerVisibleServiceRecordFilter,
};
