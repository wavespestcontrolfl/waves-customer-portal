'use strict';

// The dispatcher originally owned this framing. Share it with the other
// managed-agent readers: transport chunks do not align with SSE events.
// Leave JSON/error interpretation to each caller's existing event contract.
async function* readSessionFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; return; }
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const lines = frame.split(/\r\n|\r|\n/);
        const event = lines.filter(line => line.startsWith('event:')).at(-1)?.slice(6).trim() || 'message';
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    // Breaking on a terminal event must also close the underlying stream.
    try { if (!ended) await reader.cancel?.(); } catch { /* preserve the caller's outcome */ }
    reader.releaseLock?.();
  }
}

module.exports = { readSessionFrames };
