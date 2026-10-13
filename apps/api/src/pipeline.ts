import type { EvaluationRun, Exam } from '@poc/shared';
import type { EvaluationModel } from './model.js';
import type { RunStore } from './store.js';
import { evaluateDocuments, evaluatePreparedExam } from './evaluation.js';
import { publicError } from './errors.js';

export async function processRun(run: EvaluationRun, store: RunStore, model: EvaluationModel, answerPageCount: number, preparedExam?: Exam) {
  try {
    if (preparedExam) {
      await evaluatePreparedExam(model, preparedExam, await store.read(run.id, 'answerSheet'), answerPageCount, progress => Object.assign(run, progress));
    } else {
      const [questionPaper, answerKey, answerSheet] = await Promise.all([store.read(run.id, 'questionPaper'), store.read(run.id, 'answerKey'), store.read(run.id, 'answerSheet')]);
      await evaluateDocuments(model, { questionPaper, answerKey, answerSheet }, answerPageCount, progress => Object.assign(run, progress));
    }
  } catch (error) {
    const safe = publicError(error);
    run.error = { code: safe.code, message: safe.message, stage: run.stage };
    run.stage = 'failed';
  } finally {
    run.finishedAt = Date.now(); store.release();
    console.info(JSON.stringify({ runId: run.id, stage: run.stage, errorCode: run.error?.code, model: run.model, stageDurations: run.stageDurations, usage: run.usage }));
  }
}
