import type { Exam, Transcription, Grading } from '@poc/shared';
export const examFixture = (): Exam => ({ policyVersion: null, selectionGroups: [], marksEvidence: null, questions: [
  { identifier: '1', text: 'What is 2 + 2?', maximumMarks: 2, expectedAnswer: '4', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred' },
  { identifier: '2(a)', text: 'Solve x + 1 = 3.', maximumMarks: 3, expectedAnswer: 'x = 2', acceptedAlternatives: [], markingCriteria: ['Correct working and answer'], gradingBasis: 'supplied' },
], optionalQuestions: false, issues: [], warnings: [] });
export const transcriptionFixture = (): Transcription => ({ studentIdentity: { name: null, status: 'absent', sourcePages: [], note: 'No student name is visible.' }, answers: [
  { entryId: 'entry-1', identifier: '1', text: '4', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false, withdrawn: false, withdrawalEvidence: '' },
  { entryId: 'entry-2', identifier: '2(a)', text: '$x = 3 - 1 = 2$', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false, withdrawn: false, withdrawalEvidence: '' },
], pagesRead: [1], allPagesRead: true, warnings: [] });
export const gradingFixture = (): Grading => ({ results: examFixture().questions.map(q => ({ identifier: q.identifier, maximumMarks: q.maximumMarks, marks: q.maximumMarks, provisionalMarks: null, status: 'graded', justification: 'Correct answer.', correctPoints: ['Correct result'], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [] })), warnings: [] });
export const optionalExamFixture = (): Exam => {
  const questions = [10, 10, 10, 15, 15, 15].map((maximumMarks, index) => ({ identifier: String(index + 1), text: `Cost accounting question ${index + 1}`, maximumMarks, expectedAnswer: 'Supplied key answer', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred' as const, rubric: [{ id: 'answer', description: 'Answer', maximumMarks, expectedEvidence: 'Relevant answer', keyAlignment: 'Supplied key', allocationBasis: 'inferred' as const }] }));
  const selectionGroups = ['A', 'B'].map((id, index) => ({ id, questionIds: questions.slice(index * 3, index * 3 + 3).map(q => q.identifier), requiredCount: 2, maximumMarks: index ? 30 : 20, instructions: `Answer any two. Each carries ${index ? 15 : 10} marks.`, sourcePages: [1], excessPolicy: 'review' as const, excessInstructions: '' }));
  return { policyVersion: null, optionalQuestions: true, selectionGroups, questions, issues: [], warnings: [], marksEvidence: { printedTotal: 50, totalSource: 'Marks: 50', sections: selectionGroups.map(group => ({ identifier: group.id, heading: `PART ${group.id} (${group.requiredCount} x ${group.maximumMarks / 2} = ${group.maximumMarks} Marks)`, sourcePages: [1], headingMarks: group.maximumMarks, headingScope: 'section_total' as const, questions: group.questionIds.map(identifier => ({ identifier, printedMarks: null, source: group.instructions })) })) } };
};


