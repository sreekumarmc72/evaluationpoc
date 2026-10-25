import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BlueprintView, SectionScores } from './OptionalSections';
import type { ExamBlueprint, Totals } from '@poc/shared';

afterEach(cleanup);
it('shows choice quotas and paper evidence without exposing expected answers', () => {
  const blueprint: ExamBlueprint = { version: 2, rootId: 'root', maximumMarks: 10, totalSource: 'Maximum 10', issues: [], warnings: [], nodes: [
    { id: 'root', label: 'Exam', kind: 'all', role: 'exam', children: ['choice'], maximumMarks: 10, requiredCount: null, instructions: '', text: '', sourcePages: [1], marksSource: 'Maximum 10', excessPolicy: 'highest_scores' },
    { id: 'choice', label: 'Part II', kind: 'choose', role: 'section', children: ['a', 'b'], maximumMarks: 10, requiredCount: 1, instructions: 'Answer either question', text: '', sourcePages: [2], marksSource: 'Each carries 10', excessPolicy: 'highest_scores' },
    ...['a', 'b'].map(id => ({ id, label: `Question ${id}`, kind: 'score' as const, role: 'question' as const, children: [], maximumMarks: 10, requiredCount: null, instructions: '', text: 'Printed question', sourcePages: [2], marksSource: '10 marks', excessPolicy: 'highest_scores' as const })),
  ] };
  render(<BlueprintView blueprint={blueprint} />);
  expect(screen.getByText(/Part II · 10 marks · choose 1 of 2/)).toBeInTheDocument();
  expect(screen.getByText(/Paper pages 2 · Each carries 10/)).toBeInTheDocument();
});
it('shows awarded provisional parent and section scores together', () => {
  const totals: Totals = { maximumMarks: 14, totalMarks: null, percentage: null, gradedSubtotal: 5, provisionalTotal: 8, pendingQuestions: ['2-b'], blueprintResults: [{ nodeId: '2', label: 'Question 2', kind: 'all', maximumMarks: 14, marks: 8, counted: true, provisional: true, selectedChildren: ['2-a', '2-b'], reviewFlags: [] }], sectionResults: [{ sectionId: 'Part II', instructions: 'Answer the required questions', requiredCount: 1, maximumMarks: 14, countedQuestionIds: ['2'], notSelectedQuestionIds: [], pendingQuestionIds: ['2'], gradedSubtotal: 5, totalMarks: null, provisionalTotal: 8, reviewFlags: [], notes: [] }] };
  render(<SectionScores totals={totals} />);
  expect(screen.getByRole('heading', { name: 'Part II' })).toBeInTheDocument();
  expect(screen.getByText('8 / 14 · Provisional')).toBeInTheDocument();
  expect(screen.getByText(/Counted: 2 · Required: 1 answers/)).toBeInTheDocument();
  expect(screen.getByText('Question 2')).toBeInTheDocument();
});
