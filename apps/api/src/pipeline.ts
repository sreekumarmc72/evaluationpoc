import type { EvaluationRun, Exam } from '@poc/shared';
import type { EvaluationModel } from './model.js';
import type { RunStore } from './store.js';
import { evaluateDocuments, evaluatePreparedExam } from './evaluation.js';
import { publicError } from './errors.js';
import { modelContext, diagnostic, recoveryVersion } from './model-diagnostics.js';

export async function processRun(run: EvaluationRun, store: RunStore, model: EvaluationModel, answerPageCount: number, preparedExam?: Exam) {
  run.recoveryAvailable = true;
  run.recoveryVersion ??= recoveryVersion;
  return modelContext.run({ runId: run.id, examId: run.examId, load: key => store.readModelTask(run.id, key), save: (key, value) => store.saveModelTask(run.id, key, value) }, () => processInContext(run, store, model, answerPageCount, preparedExam));
}
async function processInContext(run: EvaluationRun, store: RunStore, model: EvaluationModel, answerPageCount: number, preparedExam?: Exam) {
  let failure: ReturnType<typeof publicError> | null = null;
  let pendingUpdate = Promise.resolve();
  const update = async (progress: Partial<EvaluationRun>) => {
    const snapshot = structuredClone(progress);
    const persist = async () => {
    const next = { ...run, ...snapshot };
    if (next.stage !== run.stage) diagnostic('stage_changed', { from: run.stage, stage: next.stage });
    if (next.stage === 'completed') next.finishedAt = Date.now();
    await store.checkpoint(next);
    Object.assign(run, next);
    };
    const result = pendingUpdate.then(persist); pendingUpdate = result.catch(() => {}); await result;
  };
  const context = modelContext.getStore();
  if (context) context.readingProgress = progress => update({ readingProgress: progress });
  try {
    if (preparedExam) {
      await evaluatePreparedExam(model, preparedExam, await store.read(run.id, 'answerSheet'), answerPageCount, update);
    } else {
      const [questionPaper, answerKey, answerSheet] = await Promise.all([store.read(run.id, 'questionPaper'), store.read(run.id, 'answerKey'), store.read(run.id, 'answerSheet')]);
      await evaluateDocuments(model, { questionPaper, answerKey, answerSheet }, answerPageCount, update);
    }
  } catch (error) {
    failure = publicError(error);
  } finally {
    if (failure) {
      try { const known = await store.knownModelUsage(run.id); if (known) { run.usage = known; run.warnings.push('Usage includes locally saved AI responses. Requests with unknown outcomes may have additional usage that is not available locally.'); } }
      catch { diagnostic('usage_reconciliation_failed'); }
      const failed = { ...run, error: { code: failure.code, message: failure.message, stage: run.stage }, stage: 'failed' as const, finishedAt: Date.now() };
      try { await store.checkpoint(failed); }
      catch { failed.error = { code: 'STORAGE_FAILURE', message: 'The evaluation could not be safely saved to disk. Contact the faculty before repeating this submission.', stage: run.stage }; }
      Object.assign(run, failed);
    }
    store.release();
    console.info(JSON.stringify({ runId: run.id, stage: run.stage, errorCode: run.error?.code, model: run.model, stageDurations: run.stageDurations, usage: run.usage }));
  }
}
