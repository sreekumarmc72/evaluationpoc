import { describe, it, expect, vi } from 'vitest';
import { evaluateDocuments, evaluatePreparedExam } from './evaluation.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
import { directResolution } from './validation.js';
import type { EvaluationModel, ModelResponse } from './model.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const files = { questionPaper: Buffer.from('paper'), answerKey: Buffer.from('key'), answerSheet: Buffer.from('student') };
function deferred() {
  let resolve!: (value: ModelResponse) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ModelResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const modelFor = (): EvaluationModel => ({
  extract: vi.fn(async () => ({ value: examFixture(), usage })),
  transcribe: vi.fn(async () => ({ value: transcriptionFixture(), usage })),
  resolve: vi.fn(async (_sheet, _questions, t) => ({ value: directResolution(t, examFixture()), usage })),
  grade: vi.fn(async () => ({ value: gradingFixture(), usage })),
});
describe('Concurrent independent document reading', () => {
  it('bypasses extraction entirely for prepared exams and keeps the supplied rubric unchanged', async () => {
    const model = modelFor(); model.extract = vi.fn(async () => { throw new Error('Extraction must never be called'); });
    const exam = examFixture(); const before = structuredClone(exam);
    const result = await evaluatePreparedExam(model, exam, files.answerSheet, 1);
    expect(result.stage).toBe('completed'); expect(result.examReused).toBe(true); expect(model.extract).not.toHaveBeenCalled();
    expect(result.stageDurations).not.toHaveProperty('reading_documents'); expect(result.stageDurations).not.toHaveProperty('extracting_exam');
    expect(result.usage.totalTokens).toBe(30); expect(exam).toEqual(before);
  });
  it('reports reused extraction while still transcribing and grading each new sheet', async () => {
    const model = modelFor(); model.extract = vi.fn(async () => ({ value: examFixture(), examReused: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }));
    const result = await evaluateDocuments(model, files, 1);
    expect(result.examReused).toBe(true); expect(result.usage.totalTokens).toBe(30);
    expect(model.transcribe).toHaveBeenCalledWith(files.answerSheet); expect(model.grade).toHaveBeenCalledOnce();
  });
  it('starts both calls before either completes and waits for both before grading', async () => {
    const exam = deferred(); const sheet = deferred(); const model = modelFor();
    model.extract = vi.fn(() => exam.promise); model.transcribe = vi.fn(() => sheet.promise);
    const stages: string[] = [];
    const run = evaluateDocuments(model, files, 1, p => stages.push(p.stage));
    expect(model.extract).toHaveBeenCalledWith(files.questionPaper, files.answerKey);
    expect(model.transcribe).toHaveBeenCalledWith(files.answerSheet);
    expect(stages[0]).toBe('reading_documents');
    sheet.resolve({ value: transcriptionFixture(), usage });
    await vi.waitFor(() => expect(stages).toContain('extracting_exam'));
    expect(model.grade).not.toHaveBeenCalled();
    exam.resolve({ value: examFixture(), usage });
    const result = await run;
    expect(result.stage).toBe('completed');
    expect(result.usage.totalTokens).toBe(45);
    expect(result.stageDurations.reading_documents).toBeGreaterThanOrEqual(0);
    expect(model.resolve).not.toHaveBeenCalled();
  });
  it('drains the remaining call after a failure and reports the actual failed stage', async () => {
    const exam = deferred(); const sheet = deferred(); const model = modelFor();
    model.extract = () => exam.promise; model.transcribe = () => sheet.promise;
    let settled = false; let latestStage = ''; let tokens = 0;
    const run = evaluateDocuments(model, files, 1, p => { latestStage = p.stage; tokens = p.usage.totalTokens; });
    const outcome = run.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    sheet.reject(new Error('Transcription connection failed'));
    await vi.waitFor(() => expect(latestStage).toBe('extracting_exam'));
    expect(settled).toBe(false);
    exam.resolve({ value: examFixture(), usage });
    expect((await outcome).message).toBe('Transcription connection failed');
    expect(latestStage).toBe('transcribing');
    expect(tokens).toBe(15);
    expect(model.grade).not.toHaveBeenCalled();
  });
});
