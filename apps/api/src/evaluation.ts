import type { EvaluationRun, UploadField, Exam } from '@poc/shared';
import type { EvaluationModel, ModelResponse } from './model.js';
import { validateExam, identifyTranscription, validateTranscription, validateGrading, needsResolution, directResolution, validateResolution, applyResolution } from './validation.js';

type Progress = Pick<EvaluationRun, 'stage' | 'exam' | 'transcription' | 'resolution' | 'resolvedTranscription' | 'results' | 'totals' | 'warnings' | 'usage' | 'stageDurations' | 'examReused'>;
// Shared by HTTP and baseline; no additional retry layer.
export async function evaluateDocuments(model: EvaluationModel, files: Record<UploadField, Buffer>, pageCount: number, update: (progress: Progress) => unknown = () => {}, preparedExam?: Exam) {
  const p: Progress = { stage: 'reading_documents', exam: null, transcription: null, resolution: null, resolvedTranscription: null, results: [], totals: null, warnings: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stageDurations: {} };
  const step = async (stage: 'extracting_exam' | 'transcribing' | 'resolving_answers' | 'evaluating', work: () => Promise<ModelResponse>, background = false) => {
    if (!background) p.stage = stage;
    await update(p); const start = Date.now();
    try {
      const response = await work();
      if (stage === 'extracting_exam') p.examReused = response.examReused === true;
      p.usage.inputTokens += response.usage.inputTokens; p.usage.outputTokens += response.usage.outputTokens; p.usage.totalTokens += response.usage.totalTokens;
      return response.value;
    } finally { p.stageDurations[stage] = Date.now() - start; await update(p); }
  };
  let transcription: ReturnType<typeof validateTranscription> | undefined;
  if (preparedExam) {
    p.exam = validateExam(structuredClone(preparedExam)); p.examReused = true; p.warnings.push(...p.exam.warnings);
    p.transcription = identifyTranscription(await step('transcribing', () => model.transcribe(files.answerSheet)));
    transcription = validateTranscription(p.transcription, pageCount); p.warnings.push(...transcription.warnings);
  } else {
  let failedStage: 'extracting_exam' | 'transcribing' | undefined;
  const readingStart = Date.now();
  const pending = new Set<'extracting_exam' | 'transcribing'>(['extracting_exam', 'transcribing']);
  const read = async (stage: 'extracting_exam' | 'transcribing', work: () => Promise<ModelResponse>, accept: (value: unknown) => void) => {
    try { accept(await step(stage, work, true)); }
    catch (error) { failedStage ??= stage; throw error; }
    finally {
      pending.delete(stage);
      if (pending.size === 1) p.stage = [...pending][0];
      await update(p);
    }
  };
  // Calls have independent inputs; neither can inspect the other call's documents.
  // Drain both calls before releasing the active slot, even if one fails.
  const readings = await Promise.allSettled([
    read('extracting_exam', () => model.extract(files.questionPaper, files.answerKey), value => {
      p.exam = validateExam(value); p.warnings.push(...p.exam.warnings);
    }),
    read('transcribing', () => model.transcribe(files.answerSheet), value => {
      p.transcription = identifyTranscription(value);
      transcription = validateTranscription(p.transcription, pageCount);
      p.warnings.push(...transcription.warnings);
    }),
  ]);
  p.stageDurations.reading_documents = Date.now() - readingStart;
  if (failedStage) {
    p.stage = failedStage; await update(p);
    const failure = readings[failedStage === 'extracting_exam' ? 0 : 1];
    if (failure.status === 'rejected') throw failure.reason;
  }
  await update(p);
  if (!p.exam || !transcription) throw new Error('Independent document processing did not complete.');
  }
  const normalizedTranscription = transcription;
  const { exam } = p;
  p.resolution = needsResolution(normalizedTranscription, exam)
    ? validateResolution(await step('resolving_answers', () => model.resolve(files.answerSheet, exam.questions.map(({ identifier, text }) => ({ identifier, text })), normalizedTranscription)), normalizedTranscription, exam)
    : validateResolution(directResolution(normalizedTranscription, exam), normalizedTranscription, exam);
  p.warnings.push(...p.resolution.warnings);
  p.resolvedTranscription = applyResolution(normalizedTranscription, p.resolution);
  const grading = validateGrading(await step('evaluating', () => model.grade(exam, p.resolvedTranscription!, p.resolution!)), exam, p.resolvedTranscription, p.resolution, normalizedTranscription);
  p.results = grading.results; p.totals = grading.totals; p.warnings.push(...grading.warnings);
  p.stage = 'completed'; await update(p); return p;
}
export function evaluatePreparedExam(model: EvaluationModel, exam: Exam, answerSheet: Buffer, pageCount: number, update: (progress: Progress) => unknown = () => {}) {
  return evaluateDocuments(model, { questionPaper: Buffer.alloc(0), answerKey: Buffer.alloc(0), answerSheet }, pageCount, update, exam);
}
