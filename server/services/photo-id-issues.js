const db = require('../models/db');
const { etCalendarDayOf, etDateString, validCalendarDate } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PhotoIdIssueError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = 'PhotoIdIssueError';
    this.code = code;
    this.status = status;
  }
}

function hasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseObservedOn(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  return validCalendarDate(value) || undefined;
}

function serializeObservedOn(value) {
  if (value == null) return null;
  try {
    return etCalendarDayOf(value);
  } catch {
    return null;
  }
}

function parseIssueFields(body, { enabled, type }) {
  const hasIssueId = hasOwn(body, 'issue_id');
  const hasObservedOn = hasOwn(body, 'observed_on');
  if (!enabled && (hasIssueId || hasObservedOn)) {
    throw new PhotoIdIssueError('Issue fields are not available', { code: 'issue_fields_disabled', status: 400 });
  }
  if (!enabled) return { enabled: false, issueId: null, observedOn: null };
  if (type !== 'pest' && (hasIssueId || hasObservedOn)) {
    throw new PhotoIdIssueError('Issue fields are only supported for pest submissions', { code: 'issue_fields_wrong_type', status: 400 });
  }
  if (type !== 'pest') return { enabled: false, issueId: null, observedOn: null };

  let issueId = null;
  if (body.issue_id != null) {
    if (typeof body.issue_id !== 'string' || !UUID_RE.test(body.issue_id)) {
      throw new PhotoIdIssueError('Invalid issue_id', { code: 'invalid_issue_id', status: 400 });
    }
    issueId = body.issue_id;
  }
  const observedOn = parseObservedOn(body.observed_on);
  if (hasObservedOn && observedOn === undefined) {
    throw new PhotoIdIssueError('observed_on must be a valid YYYY-MM-DD date', { code: 'invalid_observed_on', status: 400 });
  }
  if (observedOn && observedOn > etDateString()) {
    throw new PhotoIdIssueError('observed_on cannot be in the future', { code: 'future_observed_on', status: 400 });
  }
  return { enabled: true, issueId, observedOn: observedOn ?? null };
}

async function requireOwnedIssue({ database = db, issueId, customerId, propertyId, lock = false, status = 404 }) {
  let query = database('photo_id_issues').where({
    id: issueId,
    customer_id: customerId,
    property_id: propertyId,
  });
  if (lock) query = query.forUpdate();
  const issue = await query.first('id');
  if (!issue) {
    throw new PhotoIdIssueError('Issue not found', { code: 'issue_not_found', status });
  }
  return issue;
}

async function savePestSubmission({ database = db, issueId, customerId, propertyId, area, observedOn, submission }) {
  return database.transaction(async (trx) => {
    let savedIssueId = issueId;
    if (savedIssueId) {
      await requireOwnedIssue({
        database: trx, issueId: savedIssueId, customerId, propertyId, lock: true, status: 409,
      });
    } else {
      const [issue] = await trx('photo_id_issues').insert({
        customer_id: customerId,
        property_id: propertyId,
        area: area || null,
      }).returning(['id']);
      savedIssueId = issue.id;
    }

    const [row] = await trx('pest_identifications').insert({
      ...submission,
      issue_id: savedIssueId,
      observed_on: observedOn,
    }).returning(['id', 'created_at', 'issue_id', 'observed_on']);
    return { ...row, observed_on: observedOn };
  });
}

module.exports = {
  PhotoIdIssueError,
  parseIssueFields,
  serializeObservedOn,
  requireOwnedIssue,
  savePestSubmission,
};
