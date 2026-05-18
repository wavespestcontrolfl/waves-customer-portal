const logger = require('../logger');
const { recordToolEvent } = require('../intelligence-bar/tool-events');

const REPORT_TOKEN_PATTERN = /\/report\/[^\s"'<>]+/g;
const BODY_LIKE_KEYS = new Set([
  'body',
  'html',
  'pageText',
  'response',
  'responseBody',
  'responseText',
]);
const ERROR_LIKE_KEYS = new Set([
  'err',
  'error',
  'errorMessage',
  'last_error',
  'message',
]);

function redactReportTokens(value) {
  if (value == null) return value;
  return String(value).replace(REPORT_TOKEN_PATTERN, '/report/[redacted]');
}

function safePdfRenderError(err) {
  if (!err) return 'PDF render failed';
  const status = err.status || err.statusCode || null;
  const code = err.code || null;
  const rawMessage = err.safeMessage || err.message || String(err);
  const message = redactReportTokens(rawMessage);
  return [
    status ? `status=${status}` : null,
    code ? `code=${code}` : null,
    message || null,
  ].filter(Boolean).join(' ') || 'PDF render failed';
}

function sanitizedPdfRenderMetadata(payload = {}) {
  const metadata = { ...payload };
  for (const key of ['url', 'reportUrl', 'report_url', 'viewerUrl', 'viewer_url']) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      metadata[key] = '[redacted]';
    }
  }
  for (const key of Object.keys(metadata)) {
    if (BODY_LIKE_KEYS.has(key)) {
      metadata[key] = '[redacted]';
    } else if (ERROR_LIKE_KEYS.has(key)) {
      metadata[key] = redactReportTokens(metadata[key]);
    }
  }
  return metadata;
}

function emitPdfRenderEvent(eventName, payload = {}, success = true) {
  const errorText = payload.err || payload.error || null;
  recordToolEvent({
    source: 'service-report',
    context: 'pdf_render',
    toolName: eventName,
    success,
    durationMs: payload.elapsed_ms ?? payload.elapsedMs ?? null,
    errorMessage: errorText ? String(errorText).slice(0, 1000) : null,
    metadata: sanitizedPdfRenderMetadata(payload),
  });

  const message = `[service-report-pdf] ${eventName} ${payload.service_record_id || payload.serviceRecordId || ''}`.trim();
  if (success) logger.info(message);
  else logger.error(`${message}: ${errorText || 'unknown error'}`);
}

function emitPdfRenderSuccess(payload) {
  emitPdfRenderEvent('pdf_render_success', payload, true);
}

function emitPdfRenderFailed(payload) {
  emitPdfRenderEvent('pdf_render_failed', payload, false);
}

function emitPdfRenderTerminalFailure(payload) {
  emitPdfRenderEvent('pdf_render_terminal_failure', payload, false);
}

module.exports = {
  emitPdfRenderEvent,
  emitPdfRenderFailed,
  emitPdfRenderSuccess,
  emitPdfRenderTerminalFailure,
  redactReportTokens,
  safePdfRenderError,
  sanitizedPdfRenderMetadata,
};
