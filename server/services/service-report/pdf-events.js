const logger = require('../logger');
const { recordToolEvent } = require('../intelligence-bar/tool-events');

function sanitizedPdfRenderMetadata(payload = {}) {
  const metadata = { ...payload };
  for (const key of ['url', 'reportUrl', 'report_url', 'viewerUrl', 'viewer_url']) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      metadata[key] = '[redacted]';
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
  sanitizedPdfRenderMetadata,
};
