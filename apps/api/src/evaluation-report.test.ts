import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { RunSchema, type EvaluationRun } from '@poc/shared';
import { examFixture, gradingFixture, transcriptionFixture } from './test-fixtures.js';
import { createEvaluationReport, evaluationFeedback, reportContent } from './evaluation-report.js';

function fixture(): EvaluationRun {
  const exam = examFixture();
  exam.questions[0].rubric = [{ id: 'method', description: 'Correct method', expectedEvidence: 'Calculate ₹2 + ₹2 = ₹4', keyAlignment: 'Supplied solution', maximumMarks: 2, allocationBasis: 'inferred' }];
  const results = gradingFixture().results;
  results[0] = { ...results[0], status: 'needs_review', marks: null, provisionalMarks: 1.75, criterionAwards: [{ criterionId: 'method', marks: 1.75, evidence: 'Student calculates ₹4.', reason: 'Method earns 1.75 marks. Transcription found an unnumbered answer.', sourceEntryIds: ['private-entry'] }], reviewFlags: ['Unnumbered content needs mapping.', 'Verify whether the alternative method merits credit.'], notes: ['Page reading checkpoint failed'], justification: 'Method earns 1.75 marks. An unnumbered answer was found.' };
  return RunSchema.parse({ id: 'report-test', stage: 'completed', createdAt: 1720000000000, finishedAt: 1720000001000, exam, transcription: transcriptionFixture(), resolution: null, resolvedTranscription: null, results, totals: { maximumMarks: 5, gradedSubtotal: 3, totalMarks: null, percentage: null, provisionalTotal: 4.75, pendingQuestions: ['1'] }, warnings: ['Private API warning'], error: null, model: 'test', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, stageDurations: {}, manualStudentName: { name: 'Test Student', updatedAt: 1720000000000 } });
}
describe('Evaluation PDF reports', () => {
  it('exports assessment fields without processing diagnostics or changing saved marks', () => {
    const run = fixture(); const before = JSON.stringify(run); const report = reportContent(run, 'Accounting');
    expect(report).toMatchObject({ score: 5, rawScore: 4.75, maximumMarks: 5, provisional: true, studentName: 'Test Student' });
    expect(report.questions[0]).toMatchObject({ marks: 1.75, justification: 'Method earns 1.75 marks.', provisional: true, review: ['Verify whether the alternative method merits credit.'] });
    expect(report.questions[0].criteria[0]).toMatchObject({ marks: 1.75, reason: 'Method earns 1.75 marks.' });
    expect(JSON.stringify(report)).not.toMatch(/private-entry|API warning|checkpoint|unnumbered|transcription|inputTokens/i);
    expect(JSON.stringify(run)).toBe(before);
  });
  it('supports legacy results without rubrics and preserves optional exclusions and reviewed marks', () => {
    const run = fixture(); delete run.exam!.questions[0].rubric;
    run.results[0].teacherAdjustment = { marks: 2, reason: 'Method accepted', updatedAt: 1 };
    run.results[1].selectionStatus = 'not_selected';
    const report = reportContent(run, 'Existing exam');
    expect(report.questions[0]).toMatchObject({ marks: 2, provisional: false, criteria: [], adjustment: { marks: 2, original: 1.75 } });
    expect(report.questions[1].counted).toBe(false);
  });
  it('requires a completed evaluation, never invents a report for a failed run', async () => {
    const run = fixture(); run.stage = 'failed';
    await expect(createEvaluationReport(run, 'Exam')).rejects.toMatchObject({ code: 'REPORT_NOT_READY', status: 409 });
  });
  it('keeps academic feedback, decimal values and substantive unanswered-question deductions', () => {
    expect(evaluationFeedback('No answer was provided for this compulsory question.')).toBe('No answer was provided for this compulsory question.');
    expect(evaluationFeedback('Correct method earns 1.75 marks. API timeout on page 11. Missing final interpretation.')).toBe('Correct method earns 1.75 marks. Missing final interpretation.');
    expect(evaluationFeedback('Some answer content has an unresolved association with this question.')).toBe('');
    expect(evaluationFeedback('No mapped response.')).toBe('');
  });
  it('creates a valid multipage A4 PDF with Unicode and long content', async () => {
    const run = fixture(); run.results[0].correctPoints = Array.from({ length: 75 }, (_, i) => `Correct point ${i + 1}: ₹1,80,000 × 9% = ₹16,200. Δ = 0.5.`);
    const bytes = await createEvaluationReport(run, 'Accounting report');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2); expect(doc.getPages()[0].getWidth()).toBeCloseTo(595.28);
    expect(doc.getTitle()).toBe('Accounting report — Evaluation report');
  });
  it('paginates a rubric row longer than a page without changing its assessment data', async () => {
    const run = fixture(); const longEvidence = 'Working amount ₹16,200 remains unchanged. '.repeat(250);
    run.exam!.questions[0].rubric![0].expectedEvidence = longEvidence + 'Expected evidence end.';
    run.results[0].criterionAwards![0].evidence = longEvidence + 'Student evidence end.';
    run.exam!.questions[0].identifier = run.results[0].identifier = 'Very long question identifier '.repeat(6);
    const before = JSON.stringify(run);
    const bytes = await createEvaluationReport(run, 'Detailed rubric report');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(4);
    expect(JSON.stringify(run)).toBe(before);
    expect(reportContent(run, 'Exam').questions[0].criteria[0].evidence).toBe(longEvidence + 'Student evidence end.');
  });
});
