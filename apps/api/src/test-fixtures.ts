import type { Exam, Transcription, Grading } from '@poc/shared';
export const examFixture = (): Exam => ({ policyVersion: null, marksEvidence: null, questions: [
  { identifier: '1', text: 'What is 2 + 2?', maximumMarks: 2, expectedAnswer: '4', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred' },
  { identifier: '2(a)', text: 'Solve x + 1 = 3.', maximumMarks: 3, expectedAnswer: 'x = 2', acceptedAlternatives: [], markingCriteria: ['Correct working and answer'], gradingBasis: 'supplied' },
], optionalQuestions: false, issues: [], warnings: [] });
export const transcriptionFixture = (): Transcription => ({ studentIdentity: { name: null, status: 'absent', sourcePages: [], note: 'No student name is visible.' }, answers: [
  { entryId: 'entry-1', identifier: '1', text: '4', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false },
  { entryId: 'entry-2', identifier: '2(a)', text: '$x = 3 - 1 = 2$', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false },
], pagesRead: [1], allPagesRead: true, warnings: [] });
export const gradingFixture = (): Grading => ({ results: examFixture().questions.map(q => ({ identifier: q.identifier, maximumMarks: q.maximumMarks, marks: q.maximumMarks, provisionalMarks: null, status: 'graded', justification: 'Correct answer.', correctPoints: ['Correct result'], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [] })), warnings: [] });


