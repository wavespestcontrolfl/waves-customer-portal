// Agent-control context: the AsyncLocalStorage carrier scopes correctly —
// innermost wins, parents are never mutated, chains are shared downward,
// concurrent scopes never leak into each other, and nothing throws outside a
// scope. No DB, no network.

const mockWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn() }));

describe('agent-control context', () => {
  let ctx;
  beforeEach(() => {
    jest.resetModules();
    mockWarn.mockClear();
    ctx = require('../services/agent-control/context');
  });

  it('is all-null outside any scope and never throws', () => {
    expect(ctx.current()).toEqual({
      laneId: null, runId: null, workItemId: null, attemptId: null, stepId: null, chainId: null,
      traceId: null, spanId: null, parentSpanId: null, workload: null, promptVersion: null,
      agentVersionId: null, workflowId: null,
    });
    expect(ctx.withPromptVersion('v9', () => ctx.current().promptVersion)).toBe('v9');
    expect(ctx.current().promptVersion).toBeNull();
  });

  it('inner lane wins and the outer lane is restored afterwards', async () => {
    const seen = [];
    const result = await ctx.runInLane('sms_draft', async () => {
      seen.push(ctx.current().laneId);
      await ctx.runInLane('sms_verifier', async () => {
        await Promise.resolve();
        seen.push(ctx.current().laneId);
      });
      seen.push(ctx.current().laneId);
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual(['sms_draft', 'sms_verifier', 'sms_draft']);
    expect(ctx.current().laneId).toBeNull();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('runInRun carries the run ids and mints a trace id when none is given', () => {
    ctx.runInRun({ runId: 'r1', workItemId: 'w1', attemptId: 'a1', agentVersionId: 'av1', workflowId: 'wf1' }, () => {
      const c = ctx.current();
      expect(c).toEqual(expect.objectContaining({ runId: 'r1', workItemId: 'w1', attemptId: 'a1', agentVersionId: 'av1', workflowId: 'wf1' }));
      expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    });
    ctx.runInRun({ runId: 'r2', traceId: 'given' }, () => {
      expect(ctx.current().traceId).toBe('given');
    });
  });

  it('a run entered inside a step starts a clean trace unless it joins one explicitly', () => {
    ctx.runInRun({ runId: 'parent' }, () => ctx.withStep('outer-step', () => {
      const outer = ctx.current();
      expect(outer.traceId).toHaveLength(32);
      ctx.runInRun({ runId: 'nested' }, () => {
        const c = ctx.current();
        expect(c.traceId).not.toBe(outer.traceId);
        expect([c.stepId, c.spanId, c.parentSpanId]).toEqual([null, null, null]);
        ctx.withStep('first', () => expect(ctx.current().parentSpanId).toBeNull());
      });
      // A fresh trace started under an outer chain gets its own chain too:
      // withChain keeps any ambient chain id, so the parent's must not leak in.
      ctx.withChain(() => {
        const outerChain = ctx.current().chainId;
        ctx.runInRun({ runId: 'nested-chain' }, () => {
          expect(ctx.current().chainId).toBeNull();
          ctx.withChain(() => expect(ctx.current().chainId).not.toBe(outerChain));
        });
        ctx.runInRun({ runId: 'joined-chain', traceId: outer.traceId }, () => expect(ctx.current().chainId).toBe(outerChain));
      });
      ctx.runInRun({ runId: 'joined', traceId: outer.traceId }, () => {
        expect(ctx.current().spanId).toBe(outer.spanId);
        ctx.withStep('child', () => expect(ctx.current().parentSpanId).toBe(outer.spanId));
      });
      // An explicit trace that is NOT the ambient one is another trace too.
      ctx.runInRun({ runId: 'other', traceId: 'b'.repeat(32) }, () => {
        const c = ctx.current();
        expect([c.traceId, c.stepId, c.spanId, c.parentSpanId]).toEqual(['b'.repeat(32), null, null, null]);
      });
    }));
  });

  it('withStep chains parent span ids and mints fresh spans', () => {
    ctx.withStep('s1', () => {
      const outer = ctx.current();
      expect(outer.stepId).toBe('s1');
      expect(outer.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(outer.parentSpanId).toBeNull();
      ctx.withStep('s2', () => {
        const inner = ctx.current();
        expect(inner.stepId).toBe('s2');
        expect(inner.parentSpanId).toBe(outer.spanId);
        expect(inner.spanId).not.toBe(outer.spanId);
      });
      expect(ctx.current().spanId).toBe(outer.spanId);
    });
  });

  it('withChain shares one id downward and a nested chain keeps the outer id', () => {
    ctx.withChain(() => {
      const outer = ctx.current().chainId;
      expect(outer).toMatch(/^[0-9a-f-]{36}$/);
      ctx.runInLane('pest_id', () => expect(ctx.current().chainId).toBe(outer));
      ctx.withChain(() => expect(ctx.current().chainId).toBe(outer));
    });
    expect(ctx.current().chainId).toBeNull();
  });

  it('withWorkload validates against the taxonomy', () => {
    expect(ctx.withWorkload('replay', () => ctx.current().workload)).toBe('replay');
    expect(() => ctx.withWorkload('bogus', () => {})).toThrow(/unknown workload/);
  });

  it('concurrent scopes do not leak into each other', async () => {
    const seen = {};
    await Promise.all([
      ctx.runInLane('pest_id', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.a = ctx.current().laneId;
      }),
      ctx.runInLane('lawn_assess', async () => {
        seen.b = ctx.current().laneId;
        await new Promise((r) => setTimeout(r, 10));
        seen.b2 = ctx.current().laneId;
      }),
      (async () => { seen.c = ctx.current().laneId; })(),
    ]);
    expect(seen).toEqual({ a: 'pest_id', b: 'lawn_assess', b2: 'lawn_assess', c: null });
  });

  it('withPromptVersion scopes like any other layer: inner wins, the parent is untouched', () => {
    ctx.runInLane('sms_draft', () => {
      ctx.withPromptVersion('outer-v1', () => {
        expect(ctx.current().promptVersion).toBe('outer-v1');
        ctx.withPromptVersion('inner-v2', () => expect(ctx.current().promptVersion).toBe('inner-v2'));
        expect(ctx.current().promptVersion).toBe('outer-v1');
      });
      expect(ctx.current().promptVersion).toBe(null);
    });
  });

  it('sibling calls fanned out under one run keep their own prompt versions', async () => {
    const seen = {};
    await ctx.runInRun({ runId: 'run-1' }, () =>
      Promise.all([
        ctx.withPromptVersion('A', async () => {
          await new Promise((r) => setTimeout(r, 10));
          seen.a = ctx.current().promptVersion; // B was set meanwhile
        }),
        ctx.withPromptVersion('B', async () => {
          seen.b = ctx.current().promptVersion;
        }),
      ]),
    );
    expect(seen).toEqual({ a: 'A', b: 'B' });
  });

  it('id generators return the right hex lengths', () => {
    expect(ctx.newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.newTraceId()).not.toBe(ctx.newTraceId());
  });

  it('warns once per unknown lane id but still runs the function', () => {
    expect(ctx.runInLane('not_a_lane', () => ctx.current().laneId)).toBe('not_a_lane');
    ctx.runInLane('not_a_lane', () => {});
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatch(/not_a_lane/);
  });
});
