export function applyJobCompletion(job, result = {}, jobsState = job) {
  const next = {
    ...(job || {}),
    ...(jobsState || {}),
    lastRunAt: result.lastRunAt,
    lastStatus: result.lastStatus,
    lastError: result.lastError ?? null,
    lastDeliveryError: result.lastDeliveryError ?? null,
  };
  const applyCompletionRules = result.applyCompletionRules !== false;

  if (job?.repeat) next.repeat = { ...(job.repeat || {}), ...(next.repeat || {}) };
  if (applyCompletionRules && job?.repeat?.times != null) {
    next.repeat = { ...(next.repeat || {}) };
    next.repeat.completed = (next.repeat.completed || 0) + 1;
    if (next.repeat.completed >= next.repeat.times) {
      next.enabled = false;
      next.nextRunAt = null;
    }
  }

  if (applyCompletionRules && job?.schedule?.kind === 'once') {
    next.enabled = false;
    next.nextRunAt = null;
  }

  if (result.disableJob) {
    next.enabled = false;
    next.nextRunAt = null;
  }

  return next;
}
