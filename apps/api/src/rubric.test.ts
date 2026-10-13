import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { examFixture, gradingFixture, transcriptionFixture } from './test-fixtures.js';
import { validateExam, validateGrading } from './validation.js';
import { OpenAIModel } from './model.js';

const withRubrics = () => {
  const exam = examFixture();
  for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Correct answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Expected answer in supplied key.', allocationBasis: 'inferred' }];
  return exam;
};
describe('Answer-key aligned rubrics', () => {
  it.each(['wrong_total', 'duplicate', 'negative', 'empty_basis'])('rejects %s rubric allocations', change => {
    const exam = withRubrics(); const c = exam.questions[0].rubric![0];
    if (change === 'wrong_total') c.maximumMarks = 1;
    if (change === 'duplicate') exam.questions[0].rubric!.push({ ...c });
    if (change === 'negative') c.maximumMarks = -1;
    if (change === 'empty_basis') c.keyAlignment = '';
    expect(() => validateExam(exam)).toThrow(/rubric|Rubric/);
  });
  it('calculates marks from criterion evidence rather than a contradictory overall score', () => {
    const exam = withRubrics(); const grading = gradingFixture();
    grading.results.forEach((r, index) => { r.criterionAwards = [{ criterionId: 'answer', marks: index ? 3 : 1.5, evidence: 'Student working shows this answer.', reason: 'Partial or full credit for the observed solution.', sourceEntryIds: [`entry-${index + 1}`] }]; });
    const result = validateGrading(grading, exam, transcriptionFixture());
    expect(result.results[0].marks).toBe(1.5);
    expect(result.totals.totalMarks).toBe(4.5);
    grading.results[0].status = 'needs_review';
    const provisional = validateGrading(grading, exam, transcriptionFixture());
    expect(provisional.results[0].provisionalMarks).toBe(1.5);
  });
  it.each(['missing', 'unknown', 'over', 'foreign_evidence', 'duplicate'])('rejects %s criterion awards', change => {
    const exam = withRubrics(); const grading = gradingFixture();
    grading.results.forEach((r, index) => { r.criterionAwards = [{ criterionId: 'answer', marks: 1, evidence: 'Student answer', reason: 'Credit', sourceEntryIds: [`entry-${index + 1}`] }]; });
    const award = grading.results[0].criterionAwards![0];
    if (change === 'missing') grading.results[0].criterionAwards = [];
    if (change === 'unknown') award.criterionId = 'unknown';
    if (change === 'over') award.marks = 99;
    if (change === 'foreign_evidence') award.sourceEntryIds = ['entry-2'];
    if (change === 'duplicate') grading.results[0].criterionAwards!.push({ ...award });
    expect(() => validateGrading(grading, exam, transcriptionFixture())).toThrow(/rubric/);
  });
  it('reuses a validated rubric for identical paper/key inputs without seeing the student sheet', async () => {
    const exam = withRubrics();
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(exam) }));
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'configured-sol');
    const paper = Buffer.from('paper'); const key = Buffer.from('key');
    const first = await model.extract(paper, key); const second = await model.extract(paper, key);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.value).toEqual(first.value);
    expect(second.usage.totalTokens).toBe(0);
    const content = (create.mock.calls[0] as any)[0].input[0].content;
    expect(content.filter((c: any) => c.type === 'input_file').map((c: any) => c.filename)).toEqual(['question-paper.pdf', 'answer-key.pdf']);
    await model.extract(paper, Buffer.from('changed key'));
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('uses required keyed criterion awards in the SDK and converts them to public evidence rows', async () => {
    const exam = withRubrics();
    const results = Object.fromEntries(gradingFixture().results.map(({ marks, provisionalMarks, ...r }, index) => [r.identifier, { ...r, uncertaintyDecisions: {}, criterionAwards: { answer: { marks: index ? 3 : 1.5, evidence: 'Visible student answer', reason: 'Supported credit', sourceEntryIds: [`entry-${index + 1}`] } } }]));
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify({ results, warnings: [] }) }));
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'configured-sol');
    const response = await model.grade(exam, transcriptionFixture());
    const scored = validateGrading(response.value, exam, transcriptionFixture());
    expect(scored.totals.totalMarks).toBe(4.5);
    expect(scored.results[0].criterionAwards![0].criterionId).toBe('answer');
    const schema = (create.mock.calls[0] as any)[0].text.format.schema;
    expect(schema.properties.results.properties['1'].properties.criterionAwards.required).toEqual(['answer']);
    expect(schema.properties.results.properties['1'].properties).not.toHaveProperty('assessedMarks');
  });
  it('preserves credit for assessed criteria when another criterion remains unreadable', () => {
    const exam = withRubrics();
    exam.questions[0].rubric = [
      { ...exam.questions[0].rubric![0], id: 'method', maximumMarks: 1 },
      { ...exam.questions[0].rubric![0], id: 'final', maximumMarks: 1 },
    ];
    const grading = gradingFixture();
    grading.results[0].criterionAwards = [
      { criterionId: 'method', marks: 1, evidence: 'Clear method', reason: 'Correct method', sourceEntryIds: ['entry-1'] },
      { criterionId: 'final', marks: null, evidence: 'Unreadable final digit', reason: 'Needs inspection', sourceEntryIds: ['entry-1'] },
    ];
    grading.results[1].criterionAwards = [{ criterionId: 'answer', marks: 3, evidence: 'Correct answer', reason: 'Correct', sourceEntryIds: ['entry-2'] }];
    const result = validateGrading(grading, exam, transcriptionFixture());
    expect(result.results[0]).toMatchObject({ marks: null, provisionalMarks: 1, status: 'needs_review' });
    expect(result.totals.provisionalTotal).toBe(4);
    expect(result.totals.totalMarks).toBeNull();
  });
});
