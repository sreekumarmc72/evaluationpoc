import type { EvaluationRun, Exam } from '@poc/shared';
import type { EvaluationModel } from './model.js';
import type { RunStore } from './store.js';
import { evaluateDocuments, evaluatePreparedExam } from './evaluation.js';
import { publicError } from './errors.js';

export async function processRun(run: EvaluationRun, store: RunStore, model: EvaluationModel, answerPageCount: number, preparedExam?: Exam) {
  let failure: ReturnType<typeof publicError> | null = null;
  const update = async (progress: Partial<EvaluationRun>) => {
    const next = { ...run, ...structuredClone(progress) };
    if (next.stage === 'completed') next.finishedAt = Date.now();
    await store.checkpoint(next);
    Object.assign(run, next);
  };
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
      const failed = { ...run, error: { code: failure.code, message: failure.message, stage: run.stage }, stage: 'failed' as const, finishedAt: Date.now() };
      try { await store.checkpoint(failed); }
      catch { failed.error = { code: 'STORAGE_FAILURE', message: 'The evaluation could not be safely saved to disk. Contact the faculty before repeating this submission.', stage: run.stage }; }
      Object.assign(run, failed);
    }
    store.release();
    console.info(JSON.stringify({ runId: run.id, stage: run.stage, errorCode: run.error?.code, model: run.model, stageDurations: run.stageDurations, usage: run.usage }));
  }
}
