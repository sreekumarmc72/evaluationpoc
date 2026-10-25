import { describe, it, expect } from 'vitest';
import type { BlueprintNode, ExamBlueprint, Exam, QuestionResult, Transcription } from '@poc/shared';
import { validateBlueprint, blueprintTotals } from './blueprint.js';
import { validateExam, directResolution } from './validation.js';
import { frBlueprint, frExam } from './blueprint-fixtures.js';
function assess(attempts?: string[], awards: Record<string, number | null> = {}) {
  const exam = frExam(); const ids = attempts ?? exam.questions.map(q => q.identifier);
  const t: Transcription = { allPagesRead: true, pagesRead: [1], warnings: [], answers: ids.map((identifier, i) => ({ identifier, entryId: `e${i}`, text: 'Visible answer', sourcePages: [1], uncertainties: [], uncertaintyNotes: [], unsupportedContent: false })) };
  const results: QuestionResult[] = exam.questions.map(q => ({ identifier: q.identifier, maximumMarks: q.maximumMarks, marks: ids.includes(q.identifier) ? q.identifier in awards ? awards[q.identifier] : q.maximumMarks : 0, status: ids.includes(q.identifier) ? 'graded' : 'unattempted', justification: 'Assessed', correctPoints: [], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [] }));
  const totals = blueprintTotals(results, exam, t, directResolution(t, exam)); return { exam, results, t, totals };
}
describe('Version 2 exam blueprint', () => {
  it('validates the Financial Reporting structure with 23 MCQs and nested choices at 100, not 118', () => {
    expect(validateBlueprint(frBlueprint()).maximumMarks).toBe(100); expect(validateExam(frExam()).blueprint?.version).toBe(2);
    const { totals } = assess(); expect(totals.totalMarks).toBe(100); expect(totals.sectionResults?.map(s => s.totalMarks)).toEqual([30, 70]);
    expect(totals.sectionResults?.[1].requiredCount).toBe(5);
    expect(totals.sectionResults?.[1].countedQuestionIds).toEqual(['II-1', 'II-2', 'II-3', 'II-4', 'II-5']);
  });
  it('selects the better internal alternative before comparing complete parent totals', () => {
    const { totals, results } = assess(undefined, { 'II-2-a': 7, 'II-2-b-Either': 1, 'II-2-b-Or': 3 });
    expect(totals.blueprintResults?.find(n => n.nodeId === 'II-2')?.marks).toBe(10);
    expect(results.find(r => r.identifier === 'II-2-b-Or')?.selectionStatus).toBe('not_selected'); // Parent 2 loses to the other four 14-mark parents.
    expect(totals.totalMarks).toBe(100);
  });
  it('counts partial parents without borrowing another question subpart', () => {
    const { totals } = assess(['II-1', 'II-2-a', 'II-3-a', 'II-4-a', 'II-6-a']);
    expect(totals.totalMarks).toBe(45); // 14 + 10 + 8 + 8 + 5
    expect(totals.blueprintResults?.find(n => n.nodeId === 'II-CHOICE')?.selectedChildren).toHaveLength(4);
  });
  it('preserves provisional awards and recalculates parent selection after teacher adjustments', () => {
    const run = assess(['II-1', 'II-2-a', 'II-2-b-Or', 'II-3-a', 'II-4-a', 'II-5-a', 'II-6-a']);
    const q = run.results.find(r => r.identifier === 'II-2-a')!; q.marks = null; q.provisionalMarks = 5; q.status = 'needs_review';
    const totals = blueprintTotals(run.results, run.exam); expect(totals.provisionalTotal).toBe(46); expect(totals.totalMarks).toBeNull();
    q.teacherAdjustment = { marks: 10, reason: 'Verified', updatedAt: 1 };
    expect(blueprintTotals(run.results, run.exam).totalMarks).toBe(51);
  });
  it('uses printed first-in-script before the highest-score fallback', () => {
    const run = assess(['II-2-b-Either', 'II-2-b-Or'], { 'II-2-b-Either': 1 });
    const choice = run.exam.blueprint!.nodes.find(n => n.children.includes('II-2-b-Or'))!;
    choice.excessPolicy = 'first_in_script'; choice.instructions = 'Only the first answer in script order counts.';
    expect(blueprintTotals(run.results, run.exam).provisionalTotal).toBe(1);
  });
  it('does not display a nested choice section as another additive exam section', () => {
    const run = assess(); run.exam.blueprint!.nodes.find(n => n.id === 'II-CHOICE')!.role = 'section';
    const totals = blueprintTotals(run.results, run.exam);
    expect(totals.sectionResults?.map(s => s.maximumMarks)).toEqual([30, 70]);
    expect(totals.blueprintResults?.find(n => n.nodeId === 'II-CHOICE')?.maximumMarks).toBe(56);
  });
  it('ignores informational fragments but retains genuine unknown-selection review without withholding awarded marks', () => {
    const run = assess(['II-1', 'II-3-a']);
    run.t.answers.push({ entryId: 'fragment', identifier: null, text: 'Crossed out word', sourcePages: [1], uncertainties: [{ id: 'u', description: 'Abandoned word', sourcePages: [1], scope: 'crossed_out', impact: 'non_material' }], uncertaintyNotes: [], unsupportedContent: false });
    expect(blueprintTotals(run.results, run.exam, run.t, directResolution(run.t, run.exam)).totalMarks).toBe(22);
    run.t.answers.at(-1)!.uncertainties = [];
    const totals = blueprintTotals(run.results, run.exam, run.t, directResolution(run.t, run.exam));
    expect(totals.totalMarks).toBeNull(); expect(totals.provisionalTotal).toBe(22); expect(totals.pendingQuestions).toContain('II-CHOICE');
  });
  it('rejects out-of-range source pages and an altered mapped key', () => {
    const b = frBlueprint(); b.nodes[0].sourcePages = [2]; expect(() => validateBlueprint(b, 1)).toThrow();
    const exam = frExam(); exam.questions[0].expectedAnswer = 'Invented replacement'; expect(() => validateExam(exam)).toThrow();
  });
  it.each(['cycle', 'overlap', 'orphan', 'quota', 'total', 'missing_source', 'unequal', 'missing_key'])('rejects %s before grading', kind => {
    const exam = frExam(); const b = exam.blueprint!;
    if (kind === 'cycle') b.nodes.find(n => n.id === 'II-2')!.children.push('EXAM');
    if (kind === 'overlap') b.nodes.find(n => n.id === 'II')!.children.push('II-2-a');
    if (kind === 'orphan') b.nodes.push({ ...b.nodes[2], id: 'orphan' });
    if (kind === 'quota') b.nodes.find(n => n.id === 'II-CHOICE')!.requiredCount = 5;
    if (kind === 'total') b.maximumMarks = 118;
    if (kind === 'missing_source') b.nodes[0].marksSource = '';
    if (kind === 'unequal') b.nodes.find(n => n.id === 'II-2-b-Or')!.maximumMarks = 5;
    if (kind === 'missing_key') exam.keyMappings!.pop();
    expect(() => validateExam(exam)).toThrow();
  });
});
