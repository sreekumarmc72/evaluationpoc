import { describe, expect, it } from 'vitest';
import type { Grading, Transcription } from '@poc/shared';
import { optionalExamFixture, examFixture } from './test-fixtures.js';
import { validateExam, validateGrading, directResolution, applyResolution, calculateTotals, validateTranscription } from './validation.js';
import { activeAnswers } from './optional-sections.js';

function answers(ids: Array<string | null>): Transcription {
  return { answers: ids.map((identifier, index) => ({ entryId: `entry-${index + 1}`, identifier, text: 'Visible final answer', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false, withdrawn: false, withdrawalEvidence: '' })), pagesRead: [1], allPagesRead: true, warnings: [] };
}
function evaluate(t: Transcription, exam = optionalExamFixture(), scores: Record<string, number> = {}, candidates?: string[]) {
  validateExam(exam);
  const resolution = directResolution(t, exam); const active = activeAnswers(t, exam);
  if (candidates) for (const mapping of resolution.mappings) if (mapping.questionId === null) mapping.candidateQuestionIds = candidates;
  const grading: Grading = { results: exam.questions.map(q => {
    const source = active.filter(a => a.identifier === q.identifier); const marks = source.length ? scores[q.identifier] ?? q.maximumMarks : 0;
    return { identifier: q.identifier, maximumMarks: q.maximumMarks, marks, status: source.length ? 'graded' : 'unattempted', justification: 'Assessed independently.', correctPoints: [], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [], criterionAwards: [{ criterionId: 'answer', marks, evidence: source.length ? 'Visible answer' : '', reason: 'Rubric assessment', sourceEntryIds: source.map(a => a.entryId) }] };
  }), warnings: [] };
  return validateGrading(grading, exam, applyResolution(t, resolution), resolution, t);
}
describe('Optional sections', () => {
  it('scores two answers per section out of 50, not the 75 available marks', () => {
    const scored = evaluate(answers(['1', '3', '4', '6']));
    expect(scored.totals).toMatchObject({ maximumMarks: 50, totalMarks: 50, percentage: 100, pendingQuestions: [] });
    expect(scored.totals.sectionResults?.map(s => s.totalMarks)).toEqual([20, 30]);
    expect(scored.results.filter(r => r.selectionStatus === 'not_selected').map(r => r.identifier)).toEqual(['2', '5']);
    expect(scored.results.find(r => r.identifier === '2')?.missingPoints).toEqual([]);
  });
  it('keeps the denominator and gives zero for missing answer slots without penalising alternatives', () => {
    const scored = evaluate(answers(['2', '4', '5']));
    expect(scored.totals.totalMarks).toBe(40); expect(scored.totals.maximumMarks).toBe(50);
    expect(scored.totals.sectionResults?.[0].notes[0]).toMatch(/1 of 2/);
    expect(evaluate(answers([])).totals.totalMarks).toBe(0);
  });
  it('counts an attempted wrong answer worth zero rather than selecting a different alternative', () => {
    const scored = evaluate(answers(['1', '2', '4', '5']), undefined, { '1': 0 });
    expect(scored.results.find(r => r.identifier === '1')?.selectionStatus).toBe('counted');
    expect(scored.totals.totalMarks).toBe(40);
  });
  it('withholds an over-attempted section without silently taking best or first answers', () => {
    const scored = evaluate(answers(['1', '2', '3', '4', '5']), undefined, { '1': 1, '2': 5, '3': 10 });
    expect(scored.totals).toMatchObject({ gradedSubtotal: 30, totalMarks: null, provisionalTotal: null, pendingQuestions: ['1', '2', '3'] });
    expect(scored.totals.sectionResults?.[1].totalMarks).toBe(30);
    expect(scored.totals.sectionResults?.[0].reviewFlags[0]).toMatch(/No highest-score or first-answer/);
  });
  it('uses first-in-script only with an explicit printed policy, not question-number order', () => {
    const exam = optionalExamFixture(); exam.selectionGroups![0].excessPolicy = 'first_in_script'; exam.selectionGroups![0].excessInstructions = 'If more than two are attempted, count the first two answers in the script.';
    const scored = evaluate(answers(['3', '1', '2', '4', '5']), exam, { '1': 1, '2': 10, '3': 5 });
    expect(scored.totals.totalMarks).toBe(36);
    expect(scored.totals.sectionResults?.[0].countedQuestionIds).toEqual(['1', '3']);
    expect(scored.results.find(r => r.identifier === '2')?.selectionStatus).toBe('not_selected');
  });
  it('uses source-page order before entry order for an explicit first-in-script policy', () => {
    const exam = optionalExamFixture(); exam.selectionGroups![0].excessPolicy = 'first_in_script'; exam.selectionGroups![0].excessInstructions = 'Count only the first two attempted answers.';
    const t = answers(['1', '2', '3', '4', '5']); t.pagesRead = [1, 2]; t.answers[0].sourcePages = [2];
    const scored = evaluate(t, exam, { '1': 10, '2': 2, '3': 3 });
    expect(scored.totals.totalMarks).toBe(35);
    expect(scored.results.find(r => r.identifier === '1')?.selectionStatus).toBe('not_selected');
  });
  it('scopes unknown labels conservatively and never declares uncertain content absent', () => {
    const scored = evaluate(answers(['1', '2', '4', '5', null]));
    expect(scored.totals.totalMarks).toBeNull(); expect(scored.totals.pendingQuestions).toHaveLength(6);
  });
  it('keeps an unrelated section final when ambiguous content has candidates only in Part A', () => {
    const scored = evaluate(answers(['1', '2', '4', '5', null]), undefined, {}, ['3']);
    expect(scored.totals.gradedSubtotal).toBe(30);
    expect(scored.totals.pendingQuestions).toEqual(['1', '2', '3']);
    expect(scored.totals.sectionResults?.[1].totalMarks).toBe(30);
  });
  it('keeps evidence-based provisional awards for counted answers with the fixed exam maximum', () => {
    const exam = optionalExamFixture(); const scored = evaluate(answers(['1', '2', '4', '5']), exam);
    const question = scored.results.find(r => r.identifier === '1')!;
    question.marks = null; question.provisionalMarks = 7.5; question.status = 'needs_review'; question.reviewFlags = ['Verify a handwritten amount'];
    const totals = calculateTotals(scored.results, exam);
    expect(totals).toMatchObject({ maximumMarks: 50, totalMarks: null, provisionalTotal: 47.5, pendingQuestions: ['1'] });
    expect(totals.sectionResults?.[0].provisionalTotal).toBe(17.5);
  });
  it('requires a key for every available alternative, including an unanswered one', () => {
    const exam = optionalExamFixture(); exam.questions[2].expectedAnswer = ''; exam.questions[2].rubric = [];
    expect(() => validateExam(exam)).toThrow(/answer key/);
  });
  it('retains cancelled work in the source but excludes a clearly withdrawn optional answer', () => {
    const t = answers(['1', '2', '3', '4', '5']);
    t.answers[1].withdrawn = true; t.answers[1].withdrawalEvidence = 'Entire question 2 answer struck through on page 1.';
    const scored = evaluate(t);
    expect(scored.totals.totalMarks).toBe(50); expect(t.answers).toHaveLength(5);
    expect(scored.results.find(r => r.identifier === '2')?.selectionStatus).toBe('not_selected');
    t.answers[1].withdrawalEvidence = ''; expect(() => validateTranscription(t, 1)).toThrow(/cancellation evidence/);
  });
  it('recalculates teacher adjustments using the same counted selection', () => {
    const exam = optionalExamFixture(); const scored = evaluate(answers(['1', '2', '4', '5']), exam, { '1': 5 });
    scored.results.find(r => r.identifier === '1')!.teacherAdjustment = { marks: 10, reason: 'Verified working', updatedAt: 1 };
    scored.results.find(r => r.identifier === '3')!.teacherAdjustment = { marks: 10, reason: 'Unselected', updatedAt: 1 };
    expect(calculateTotals(scored.results, exam).totalMarks).toBe(50);
  });
  it.each(['overlap', 'unknown', 'bad_count', 'wrong_total', 'unequal', 'missing_groups', 'missing_source', 'missing_policy_source'])('rejects %s selection instructions', kind => {
    const exam = optionalExamFixture();
    if (kind === 'overlap') exam.selectionGroups![1].questionIds[0] = '1';
    if (kind === 'unknown') exam.selectionGroups![0].questionIds[0] = '99';
    if (kind === 'bad_count') exam.selectionGroups![0].requiredCount = 4;
    if (kind === 'wrong_total') exam.marksEvidence!.printedTotal = 75;
    if (kind === 'unequal') exam.questions[0].maximumMarks = 5;
    if (kind === 'missing_groups') delete exam.selectionGroups;
    if (kind === 'missing_source') exam.selectionGroups![0].instructions = '';
    if (kind === 'missing_policy_source') exam.selectionGroups![0].excessPolicy = 'first_in_script';
    expect(() => validateExam(exam)).toThrow();
  });
  it('keeps legacy compulsory specifications unchanged', () => {
    const exam = examFixture(); delete exam.selectionGroups;
    expect(validateExam(exam)).toEqual(exam);
  });
});
