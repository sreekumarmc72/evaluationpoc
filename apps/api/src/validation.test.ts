import { describe, it, expect } from 'vitest';
import { validateExam, validateTranscription, validateGrading, directResolution, applyResolution } from './validation.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';

describe('Exam and transcription integrity', () => {
  it('preserves readable names with page evidence and does not turn name uncertainty into grading blockers', () => {
    const t = transcriptionFixture(); t.studentIdentity = { name: '  Anu Thomas  ', status: 'readable', sourcePages: [1], note: 'Name field.' };
    expect(validateTranscription(t, 1).studentIdentity?.name).toBe('Anu Thomas');
    t.studentIdentity = { name: 'Guessed name', status: 'readable', sourcePages: [2], note: 'No inspected source.' };
    const unclear = validateTranscription(t, 1);
    expect(unclear.studentIdentity).toMatchObject({ name: null, status: 'unclear', sourcePages: [] });
    expect(unclear.answers[0].uncertainties).toHaveLength(0);
    expect(unclear.answers).toHaveLength(2);
  });
  it('rejects optional questions, missing marks, missing keys and reported conflicts', () => {
    expect(() => validateExam({ ...examFixture(), optionalQuestions: true })).toThrow(/Optional/);
    expect(() => validateExam({ ...examFixture(), issues: ['Marks conflict'] })).toThrow(/Marks conflict/);
    for (const change of [{ maximumMarks: 0 }, { expectedAnswer: '' }, { identifier: '2(a)' }]) {
      const exam = examFixture(); Object.assign(exam.questions[0], change); expect(() => validateExam(exam)).toThrow();
    }
  });
  it('rejects impossible source pages and falsely complete coverage', () => {
    const t = transcriptionFixture(); t.answers[0].sourcePages = [2]; expect(() => validateTranscription(t, 1)).toThrow();
    expect(() => validateTranscription(transcriptionFixture(), 2)).toThrow(/missing pages/);
  });
});
describe('Scoring integrity', () => {
  it('retains the assessed numeric award when a material uncertainty converts a grade to provisional', () => {
    const t = transcriptionFixture(); t.answers[0].uncertainties = [{ id: 'u1', description: 'Check last digit', sourcePages: [1], scope: 'final_answer', impact: 'potentially_score_changing' }];
    const g = gradingFixture(); g.results[0].marks = 1.5; g.results[0].provisionalMarks = 0;
    g.results[0].uncertaintyDecisions = [{ uncertaintyId: 'u1', affectsMarks: true, reason: 'One digit could change a small deduction.' }];
    const result = validateGrading(g, examFixture(), t);
    expect(result.results[0]).toMatchObject({ marks: null, provisionalMarks: 1.5, status: 'needs_review' });
    expect(result.totals.provisionalTotal).toBe(4.5);
  });
  it('groups explicit subparts for an aggregate score while preserving their text and pages', () => {
    const t = transcriptionFixture(); t.answers[0].identifier = '1(i)';
    t.answers.push({ ...t.answers[0], entryId: 'entry-3', identifier: '1(ii)', text: 'Student working', sourcePages: [2] });
    const resolution = directResolution(t, examFixture()); const aligned = applyResolution(t, resolution);
    expect(aligned.answers.filter(a => a.identifier === '1').map(a => a.text)).toEqual(['4', 'Student working']);
    expect(t.answers[0].identifier).toBe('1(i)');
    expect(aligned.answers[2].sourcePages).toEqual([2]);
    expect(validateGrading(gradingFixture(), examFixture(), aligned).totals.totalMarks).toBe(5);
  });
  it('preserves independently scored subparts and unknown or unnumbered content', () => {
    const t = transcriptionFixture(); t.answers.push({ ...t.answers[0], entryId: 'entry-3', identifier: null });
    expect(applyResolution(t, directResolution(t, examFixture())).answers).toEqual(t.answers);
  });
  it('computes fractional totals in code', () => {
    const g = gradingFixture(); g.results[0].marks = 1.5;
    expect(validateGrading(g, examFixture(), transcriptionFixture()).totals).toEqual({ maximumMarks: 5, gradedSubtotal: 4.5, totalMarks: 4.5, percentage: 90, pendingQuestions: [], provisionalTotal: 4.5, provisionalPercentage: 90 });
  });
  it('retains evidence-based provisional marks and a tentative total while review is pending', () => {
    const g = gradingFixture(); g.results[0].status = 'needs_review'; g.results[0].marks = null; g.results[0].provisionalMarks = 1.5; g.results[0].reviewFlags = ['Verify handwritten digit.'];
    const validated = validateGrading(g, examFixture(), transcriptionFixture());
    expect(validated.results[0].provisionalMarks).toBe(1.5);
    expect(validated.totals.totalMarks).toBeNull();
    expect(validated.totals.provisionalTotal).toBe(4.5);
    expect(validated.totals.gradedSubtotal).toBe(3);
  });
  it('rejects impossible provisional marks and never invents one for missing evidence', () => {
    const g = gradingFixture(); g.results[0].provisionalMarks = 99;
    expect(() => validateGrading(g, examFixture(), transcriptionFixture())).toThrow(/provisional/);
    g.results[0].provisionalMarks = null; g.results[0].marks = null; g.results[0].status = 'needs_review';
    expect(validateGrading(g, examFixture(), transcriptionFixture()).totals.provisionalTotal).toBeNull();
  });
  it.each(['duplicate', 'unknown', 'missing', 'over', 'negative', 'malformed', 'wrong_max'])('rejects %s grades', kind => {
    const g = gradingFixture();
    if (kind === 'duplicate') g.results[1].identifier = '1';
    if (kind === 'unknown') g.results[0].identifier = '99';
    if (kind === 'missing') g.results.pop();
    if (kind === 'over') g.results[0].marks = 20;
    if (kind === 'negative') g.results[0].marks = -1;
    if (kind === 'wrong_max') g.results[0].maximumMarks = 100;
    const value = kind === 'malformed' ? { results: 'invalid' } : g;
    expect(() => validateGrading(value, examFixture(), transcriptionFixture())).toThrow();
  });
  it.each(['review_with_score', 'graded_without_score', 'unattempted_with_content'])('withholds inconsistent %s scores without losing other grades', kind => {
    const g = gradingFixture();
    if (kind === 'review_with_score') g.results[0].status = 'needs_review';
    if (kind === 'graded_without_score') g.results[0].marks = null;
    if (kind === 'unattempted_with_content') { g.results[0].status = 'unattempted'; g.results[0].marks = 0; }
    const result = validateGrading(g, examFixture(), transcriptionFixture());
    expect(result.results[0].status).toBe('needs_review');
    expect(result.results[0].marks).toBeNull();
    expect(result.results[0].reviewFlags.length).toBeGreaterThan(0);
    expect(result.results[1].marks).toBe(3);
    expect(result.totals).toMatchObject({ gradedSubtotal: 3, totalMarks: null, percentage: null, pendingQuestions: ['1'] });
  });
  it('keeps informational scan warnings without withholding reliable grades', () => {
    const t = transcriptionFixture(); t.warnings = ['Faint reverse-side show-through; all answers readable.'];
    expect(validateGrading(gradingFixture(), examFixture(), t).totals.totalMarks).toBe(5);
  });
  it('withholds an unexplained score while retaining other valid grades', () => {
    const g = gradingFixture(); g.results[0].justification = '  ';
    const result = validateGrading(g, examFixture(), transcriptionFixture());
    expect(result.results[0]).toMatchObject({ marks: null, status: 'needs_review', reviewFlags: ['Missing model justification.'] });
    expect(result.results[0].justification.trim()).not.toBe('');
    expect(result.results[1].marks).toBe(3);
    expect(result.totals).toMatchObject({ totalMarks: null, percentage: null, gradedSubtotal: 3 });
  });
  it('normalizes a literal null ID without guessing an answer mapping', () => {
    const t = transcriptionFixture(); t.answers[0].identifier = 'null';
    expect(validateTranscription(t, 1).answers[0].identifier).toBeNull();
  });
  it.each(['illegible', 'symbol', 'diagram'])('withholds final marks for %s uncertainty even when the model grades it', kind => {
    const t = transcriptionFixture();
    if (kind === 'illegible') t.answers[0].text = '[illegible]';
    if (kind === 'symbol') t.answers[0].uncertaintyNotes = ['Could be 4 or 9'];
    if (kind === 'diagram') t.answers[0].unsupportedContent = true;
    const result = validateGrading(gradingFixture(), examFixture(), t);
    expect(result.results[0].marks).toBeNull(); expect(result.totals.totalMarks).toBeNull(); expect(result.totals.percentage).toBeNull(); expect(result.totals.gradedSubtotal).toBe(3);
  });
  it('does not treat unmatched content or incomplete pages as an unattempted answer', () => {
    for (const t of [{ ...transcriptionFixture(), allPagesRead: false }, { ...transcriptionFixture(), answers: [{ ...transcriptionFixture().answers[0], identifier: null }] }]) {
      expect(validateGrading(gradingFixture(), examFixture(), t).results.every(r => r.marks === null)).toBe(true);
    }
  });
  it('assigns zero to an answer proven absent in a complete transcription', () => {
    const t = transcriptionFixture(); t.answers.pop();
    const r = validateGrading(gradingFixture(), examFixture(), t);
    expect(r.results[1].status).toBe('unattempted'); expect(r.results[1].marks).toBe(0);
  });
});

