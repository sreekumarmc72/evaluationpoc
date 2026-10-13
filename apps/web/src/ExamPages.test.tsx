import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FacultyPage, StudentPage, StudentProgress } from './ExamPages';
import type { PreparedExam, EvaluationRun } from '@poc/shared';

const id = '11111111-1111-4111-8111-111111111111';
const exam = (status: PreparedExam['status'] = 'ready'): PreparedExam => ({ id, name: 'Accounting test', version: 1, status, model: 'gpt-6.1-sol', createdAt: 1, finishedAt: status === 'preparing' ? null : 2, documents: { questionPaper: { name: 'paper.pdf', pages: 1, sha256: 'a' }, answerKey: { name: 'key.pdf', pages: 1, sha256: 'b' } }, questionCount: 1, maximumMarks: 6, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 100, warnings: [], error: status === 'failed' ? { code: 'MODEL_REFUSAL', message: 'Preparation refused.' } : null });
const specification = { policyVersion: null, questions: [{ identifier: '1', text: 'Journal entry', maximumMarks: 6, expectedAnswer: 'Correct journal', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred', rubric: [{ id: 'R1', description: 'Accounts and amounts', maximumMarks: 6, expectedEvidence: 'Correct ledger', keyAlignment: 'Answer key', allocationBasis: 'inferred' }] }], optionalQuestions: false, issues: [], warnings: [] };
const result = (): EvaluationRun => ({ id: 'submission', examId: id, examVersion: 1, examReused: true, stage: 'completed', createdAt: 1, finishedAt: 2, exam: specification as EvaluationRun['exam'], transcription: null, resolution: null, resolvedTranscription: null, results: [{ identifier: '1', maximumMarks: 6, marks: 6, status: 'graded', justification: 'Correct accounts and amounts.', correctPoints: ['Correct journal'], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [], criterionAwards: [{ criterionId: 'R1', marks: 6, evidence: 'Correct journal', reason: 'Matches key', sourceEntryIds: [] }] }], totals: { maximumMarks: 6, gradedSubtotal: 6, totalMarks: 6, percentage: 100, pendingQuestions: [] }, warnings: [], error: null, model: 'gpt-6.1-sol', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, stageDurations: { transcribing: 100, evaluating: 100 } });
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Student progress', () => {
  it('updates elapsed seconds while processing and freezes at the completion time', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const running = { ...result(), stage: 'transcribing' as const, createdAt: 5000, finishedAt: null };
    const { rerender } = render(<StudentProgress run={running} />);
    expect(screen.getByRole('timer')).toHaveTextContent('Elapsed: 5s.');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('timer')).toHaveTextContent('Elapsed: 7s.');
    rerender(<StudentProgress run={{ ...running, stage: 'completed', finishedAt: 12000 }} />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('timer')).toHaveTextContent('Elapsed: 7s.');
    expect(screen.getByRole('timer')).not.toHaveTextContent('Keep this page open');
  });
  it('distinguishes completed, active and waiting steps', () => {
    render(<StudentProgress run={{ ...result(), stage: 'transcribing' }} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('Completed');
    expect(steps[1]).toHaveTextContent('In progress');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[2]).toHaveTextContent('Waiting');
    expect(steps[3]).toHaveTextContent('Waiting');
  });
  it('shows skipped mapping and completed grading after completion', () => {
    render(<StudentProgress run={result()} />);
    expect(screen.getAllByText('Completed')).toHaveLength(3);
    expect(screen.getByText('Skipped — not needed')).toBeInTheDocument();
  });
  it('shows completed mapping when the resolution call ran', () => {
    render(<StudentProgress run={{ ...result(), stage: 'evaluating', stageDurations: { resolving_answers: 100 } }} />);
    expect(screen.getAllByRole('listitem')[2]).toHaveTextContent('Completed');
    expect(screen.getAllByRole('listitem')[3]).toHaveTextContent('In progress');
  });
  it('marks the failed step stopped rather than completed', () => {
    render(<StudentProgress run={{ ...result(), stage: 'failed', error: { code: 'MODEL_ERROR', stage: 'transcribing', message: 'Failed' } }} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('Completed');
    expect(steps[1]).toHaveTextContent('Stopped');
    expect(steps[2]).toHaveTextContent('Not started');
    expect(steps[1]).not.toHaveAttribute('aria-current');
  });
});
describe('Faculty page', () => {
  it('creates a named exam with two PDFs and displays its preparation status', async () => {
    let created = false;
    const mock = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'POST') { created = true; return response({ id }, 202); } return response({ exams: created ? [exam('preparing')] : [] }); });
    vi.stubGlobal('fetch', mock); render(<FacultyPage />); await screen.findByText(/No exams yet/);
    fireEvent.change(screen.getByLabelText('Exam name'), { target: { value: 'Accounting test' } });
    for (const label of ['Question paper', 'Answer key']) fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['pdf'], 'test.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Create exam' }));
    await screen.findByText('Preparing');
    const body = mock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as FormData;
    expect(body.get('name')).toBe('Accounting test'); expect(body.get('model')).toBe('gpt-6.1-sol'); expect(body.get('questionPaper')).toBeInstanceOf(File); expect(body.get('answerSheet')).toBeNull();
  });
  it('shows the ready exam rubric and provides a retry for failed preparation', async () => {
    const failed = { ...exam('failed'), id: '22222222-2222-4222-8222-222222222222', name: 'Failed exam' };
    const mock = vi.fn(async (url: string, init?: RequestInit) => response(init?.method === 'POST' ? { id: failed.id } : url === '/api/exams' ? { exams: [exam(), failed] } : { metadata: exam(), specification }, init?.method === 'POST' ? 202 : 200));
    vi.stubGlobal('fetch', mock); render(<FacultyPage />); await screen.findByText('Ready');
    expect(screen.getByText('Preparation refused.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View questions & rubric' })); await screen.findByText('Accounts and amounts');
    expect(screen.getByText(/AI-generated, not teacher-approved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preparation' }));
    await waitFor(() => expect(mock.mock.calls.some(([url, init]) => url.endsWith('/prepare') && init?.method === 'POST')).toBe(true));
  });
});
describe('Student page', () => {
  it('only offers ready exams and submits one sheet, displaying marks and rubric without teacher adjustment controls', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => response(url === '/api/exams' ? { exams: [exam(), { ...exam('preparing'), id: '22222222-2222-4222-8222-222222222222', name: 'Not ready' }] } : init?.method === 'POST' ? { id: 'submission' } : result(), init?.method === 'POST' ? 202 : 200));
    vi.stubGlobal('fetch', mock); render(<StudentPage />); await screen.findByLabelText('Choose exam');
    expect(screen.queryByRole('option', { name: /Not ready/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Handwritten answer sheet'), { target: { files: [new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for evaluation' })); await screen.findByText('6 / 6');
    const [url, init] = mock.mock.calls.find(([, init]) => init?.method === 'POST')!; expect(url).toBe(`/api/exams/${id}/evaluations`);
    const body = init!.body as FormData; expect(body.get('answerSheet')).toBeInstanceOf(File); expect(body.get('questionPaper')).toBeNull(); expect(body.get('answerKey')).toBeNull();
    expect(screen.getByText('Marking rubric & how it was applied')).toBeInTheDocument(); expect(screen.queryByText('Review or adjust marks')).not.toBeInTheDocument();
  });
  it('explains empty exam selection and reconnects to a saved submission without posting again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ exams: [] }))); const view = render(<StudentPage />);
    await screen.findByText(/No prepared exams/); view.unmount();
    sessionStorage.setItem('student-run-id', 'submission');
    const mock = vi.fn(async (url: string) => response(url === '/api/exams' ? { exams: [exam()] } : result())); vi.stubGlobal('fetch', mock);
    render(<StudentPage />); await screen.findByText('6 / 6'); expect(mock.mock.calls.every(([url]) => url === '/api/exams' || url === '/api/evaluations/submission')).toBe(true);
  });
  it('shows failed evaluations and resets safely when the run has expired', async () => {
    sessionStorage.setItem('student-run-id', 'expired');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/exams' ? { exams: [exam()] } : { error: { message: 'Submission expired.' } }, url === '/api/exams' ? 200 : 404)));
    render(<StudentPage />); await screen.findByRole('heading', { name: 'Submission expired' });
    fireEvent.click(screen.getByRole('button', { name: 'New submission' })); await screen.findByRole('heading', { name: 'Submit answer sheet' });
    expect(sessionStorage.getItem('student-run-id')).toBeNull();
  });
});
