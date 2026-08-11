'use strict';

const crypto = require('node:crypto');
const store = require('./workflow-store');

function retryDelayMs(attempts) {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
}

async function executeGraph(db, definition, runId, services = {}) {
  let run = await store.getRun(db, runId);
  if (!run) throw new Error(`workflow run not found: ${runId}`);
  if (run.status === 'completed' || run.status === 'failed') return run;

  let state = run.state || {};
  for (const stepDefinition of definition.steps) {
    run = await store.getRun(db, runId);
    const step = run.steps.find(item => item.step_key === stepDefinition.key);
    if (!step) throw new Error(`workflow step missing: ${stepDefinition.key}`);
    if (step.status === 'completed' || step.status === 'skipped') continue;
    if (step.status === 'waiting') return run;
    // Another worker owns the external-effect boundary. It will either finish
    // or the stale-run recovery policy will decide whether replay is safe.
    if (step.status === 'running') return run;
    if (step.status === 'retry' && new Date(step.available_at).getTime() > Date.now()) return run;

    const stepInput = { workflowInput: run.input, state };
    const lease = await store.beginStep(
      db,
      runId,
      stepDefinition.key,
      stepInput,
      services.workerId || `inline:${process.pid}:${crypto.randomUUID()}`,
      stepDefinition.leaseMs,
    );
    if (!lease) return store.getRun(db, runId);
    try {
      const result = await stepDefinition.run({
        db,
        run,
        input: run.input,
        state,
        services,
        store,
        stepKey: stepDefinition.key,
      });
      if (result?.waiting) {
        throw Object.assign(new Error('waiting steps are not implemented yet'), { code: 'unsupported_wait_state' });
      }
      const output = result?.output ?? result ?? {};
      state = { ...state, [stepDefinition.key]: output };
      await store.completeStep(db, runId, stepDefinition.key, output, state);
    } catch (error) {
      const latest = await store.getRun(db, runId);
      const current = latest.steps.find(item => item.step_key === stepDefinition.key);
      const retryable = error?.retryable === true && current.attempts < current.max_attempts;
      const retryAt = retryable
        ? new Date(Date.now() + retryDelayMs(current.attempts)).toISOString()
        : null;
      await store.failStep(db, runId, stepDefinition.key, error, { retry: retryable, retryAt });
      return store.getRun(db, runId);
    }
  }

  const output = typeof definition.output === 'function'
    ? definition.output({ input: run.input, state })
    : state;
  await store.completeRun(db, runId, output);
  return store.getRun(db, runId);
}

async function startGraph(db, definition, request, services = {}) {
  if (typeof definition.validate === 'function') definition.validate(request.input || {});
  const created = await store.createRun(db, { definition, ...request });
  if (!created.created) return created.run;
  return executeGraph(db, definition, created.run.id, services);
}

module.exports = { executeGraph, retryDelayMs, startGraph };
