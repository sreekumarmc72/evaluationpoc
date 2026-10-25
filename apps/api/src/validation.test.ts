import { describe, it, expect } from 'vitest';
import { validateExam, validateTranscription, validateGrading, directResolution, applyResolution, validateResolution } from './validation.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';

describe('Exam and transcription integrity', () => {
  it('retains blank mapping references as unresolved without guessing a scored question', () => {
    const t = transcriptionFixture(); const exam = examFixture(); const resolution = directResolution(t, exam);
    resolution.mappings[0] = { ...resolution.mappings[0], questionId: '', candidateQuestionIds: ['1', '2(a)'], evidence: 'An ambiguous fragment could belong to either question.' };
    const result = validateResolution(resolution, t, exam); expect(result.mappings[0].questionId).toBeNull(); expect(result.mappings[0].candidateQuestionIds).toEqual(['1', '2(a)']); expect(result.warnings.join(' ')).toContain('unresolved');
    resolution.mappings[0].questionId = 'unknown'; expect(() => validateResolution(resolution, t, exam)).toThrow();
  });
  it('retains established numeric credit when an extra fragment has an ambiguous association', () => {
    const exam = examFixture(); const t = transcriptionFixture(); t.answers.push({ ...t.answers[0], entryId: 'entry-3', identifier: null, text: 'Unlabelled margin working' });
    const resolution = directResolution(t, exam); resolution.mappings[2] = { entryId: 'entry-3', questionId: null, candidateQuestionIds: ['1'], evidence: 'Margin position is inconclusive.' };
    const value = validateGrading(gradingFixture(), exam, t, resolution);
    expect(value.results[0]).toMatchObject({ marks: null, provisionalMarks: 2, status: 'needs_review' }); expect(value.totals.provisionalTotal).toBe(5);
  });
  const sectionedExam = () => {
    const exam = examFixture();
    exam.questions = [10, 10, 15, 15].map((marks, index) => ({ ...exam.questions[0], identifier: `${index < 2 ? 'A' : 'B'}-${index % 2 + 1}`, maximumMarks: marks }));
    exam.marksEvidence = { printedTotal: 50, totalSource: 'Maximum Marks 50', sections: ['A', 'B'].map((identifier, index) => ({ identifier, heading: `Section ${identifier} - ${index ? 15 : 10} Marks`, sourcePages: [1], headingMarks: index ? 15 : 10, headingScope: 'ambiguous' as const, questions: exam.questions.slice(index * 2, index * 2 + 2).map(q => ({ identifier: q.identifier, printedMarks: q.maximumMarks, source: `${q.identifier} [${q.maximumMarks} Marks]` })) })) };
    return exam;
  };
  it('reconciles the statistics paper as 20 + 30 = 50 and retains auditable warnings', () => {
    const exam = validateExam(sectionedExam());
    expect(exam.questions.map(q => q.maximumMarks)).toEqual([10, 10, 15, 15]);
    expect(exam.warnings).toHaveLength(2);
    expect(exam.warnings[0]).toMatch(/per question.*total 20/);
    expect(validateExam(exam).warnings).toHaveLength(2);
    const t = transcriptionFixture(); t.answers[0].identifier = 'A-1'; t.answers[1].identifier = 'B-1';
    expect(directResolution(t, exam).mappings.map(m => m.questionId)).toEqual(['A-1', 'B-1']);
    t.answers[0].identifier = '1';
    expect(directResolution(t, exam).mappings[0].questionId).toBeNull();
  });
  it.each(['wrong_total', 'missing_total', 'missing_question_marks', 'explicit_section_total', 'unequal_marks', 'unknown_question', 'duplicate_question', 'unrelated_issue', 'optional'])('does not reconcile section ambiguity with %s', kind => {
    const exam = sectionedExam(); const evidence = exam.marksEvidence!;
    if (kind === 'wrong_total') evidence.printedTotal = 25;
    if (kind === 'missing_total') evidence.printedTotal = null;
    if (kind === 'missing_question_marks') evidence.sections[0].questions[0].printedMarks = null;
    if (kind === 'explicit_section_total') evidence.sections[0].headingScope = 'section_total';
    if (kind === 'unequal_marks') evidence.sections[0].headingMarks = 5;
    if (kind === 'unknown_question') evidence.sections[0].questions[0].identifier = 'C-9';
    if (kind === 'duplicate_question') evidence.sections[1].questions[0].identifier = 'A-1';
    if (kind === 'unrelated_issue') exam.issues = ['Missing key answer'];
    if (kind === 'optional') exam.optionalQuestions = true;
    expect(() => validateExam(exam)).toThrow();
  });
  it('keeps unsectioned accounting marks and legacy prepared exams unchanged', () => {
    const exam = examFixture();
    exam.questions = [6, 2, 2, 5, 10].map((maximumMarks, i) => ({ ...exam.questions[0], identifier: String(i + 1), maximumMarks }));
    delete exam.marksEvidence;
    expect(validateExam(exam)).toEqual(exam);
    exam.marksEvidence = { printedTotal: 25, totalSource: 'Total 25 marks', sections: [] };
    expect(validateExam(exam).warnings).toEqual([]);
    expect(validateExam(exam).questions.reduce((sum, q) => sum + q.maximumMarks, 0)).toBe(25);
  });
  it('accepts explicit section totals and each-question labels without treating them as ambiguous', () => {
    const exam = sectionedExam();
    const sections = exam.marksEvidence!.sections;
    sections[0].heading = 'Section A total 20 marks'; sections[0].headingMarks = 20; sections[0].headingScope = 'section_total';
    sections[1].heading = 'Section B 15 marks each'; sections[1].headingScope = 'per_question';
    expect(validateExam(exam).warnings).toEqual([]);
  });
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
    const assessed = validateGrading(g, examFixture(), transcriptionFixture());
    expect(assessed.totals.provisionalTotal).toBe(3);
    expect(assessed.results[0].marks).toBeNull();
    expect(assessed.results[0].provisionalMarks).toBeNull();
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

