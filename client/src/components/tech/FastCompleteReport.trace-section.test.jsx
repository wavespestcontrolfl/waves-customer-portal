// @vitest-environment jsdom
// TraceSection keeps an open inline tracer mounted in the same place when the
// trace stops being offered (Codex local audit on #6452): a product changed
// while tracing must not drop the tracer's points, or leave the sheet held on
// "Finish the trace first." with no tracer left to close.
import React, { useEffect } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TraceSection } from './FastCompleteReport';

afterEach(cleanup);

let mounts = 0;
function FakeTracer() {
  useEffect(() => { mounts += 1; }, []);
  return <div role="region" aria-label="Tracer" />;
}

describe('TraceSection', () => {
  test('an open tracer stays mounted when the trace stops being offered', () => {
    mounts = 0;
    const tracer = <FakeTracer />;
    const { rerender } = render(<TraceSection trace={{ zone: null }} tracer={tracer} onTrace={() => {}} optional />);
    expect(screen.getByRole('button', { name: 'Trace where we sprayed' })).toBeTruthy();
    rerender(<TraceSection trace={null} tracer={tracer} onTrace={() => {}} optional />);
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Tracer' })).toBeTruthy();
    expect(mounts).toBe(1);
  });

  test('no trace offered and no tracer open renders nothing', () => {
    const { container } = render(<TraceSection trace={null} tracer={null} onTrace={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
