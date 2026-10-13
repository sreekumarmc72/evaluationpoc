import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App, { Results } from './App';
import type { EvaluationRun } from '@poc/shared';

const run = (pending = false): EvaluationRun => ({
  id: 'test', stage: 'completed', createdAt: 0, finishedAt: 1, exam: null,
  transcription: { answers: [{ entryId: 'entry-1', identifier: '1', text: '$x = 2$', sourcePages: [1], uncertaintyNotes: [], uncertainties: [], unsupportedContent: false }], pagesRead: [1], allPagesRead: true, warnings: [] }, resolution: null, resolvedTranscription: null,
  results: [{ identifier: '1', maximumMarks: 5, marks: pending ? null : 4, status: pending ? 'needs_review' : 'graded', justification: 'One step missing.', correctPoints: [], missingPoints: ['Show working'], reviewFlags: pending ? ['Ambiguous symbol'] : [], notes: [], uncertaintyDecisions: [] }],
  totals: { maximumMarks: 5, gradedSubtotal: pending ? 0 : 4, totalMarks: pending ? null : 4, percentage: pending ? null : 80, pendingQuestions: pending ? ['1'] : [] }, warnings: [], error: null, model: 'test-sol', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stageDurations: {},
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe('Results UI', () => {
  it('shows inferred rubric allocations, key alignment and the awarded evidence', () => {
    const value = run(); value.exam = { policyVersion: null, optionalQuestions: false, issues: [], warnings: [], questions: [{ identifier: '1', text: 'Question', maximumMarks: 5, expectedAnswer: 'Expected answer', markingCriteria: [], acceptedAlternatives: [], gradingBasis: 'inferred', rubric: [{ id: 'method', description: 'Correct method', maximumMarks: 5, expectedEvidence: 'Show working', keyAlignment: 'Method in the key', allocationBasis: 'inferred' }] }] };
    value.results[0].criterionAwards = [{ criterionId: 'method', marks: 4, evidence: 'Working on page one', reason: 'One step missing', sourceEntryIds: ['entry-1'] }];
    render(<Results run={value} />);
    expect(screen.getByText('Marking rubric & how it was applied')).toBeInTheDocument();
    expect(screen.getByText(/AI-inferred rubric/)).toBeInTheDocument();
    expect(screen.getByText('Method in the key')).toBeInTheDocument();
    expect(screen.getByText('Working on page one')).toBeInTheDocument();
  });
  it('shows provisional awards and allows a teacher to submit reviewed marks with a reason', async () => {
    const value = run(true); value.results[0].provisionalMarks = 4;
    value.totals!.provisionalTotal = 4;
    const save = vi.fn(async () => {});
    render(<Results run={value} onAdjust={save} />);
    expect(screen.getByText('4 / 5 · Provisional')).toBeInTheDocument();
    expect(screen.getByText('PROVISIONAL MARKS · REVIEW RECOMMENDED')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Marks for question 1'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Review reason'), { target: { value: 'Verified amount in scan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed marks' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('1', 5, 'Verified amount in scan.'));
    expect(screen.getByText('Ambiguous symbol')).toBeInTheDocument();
  });
  it('shows proposed marks and read-only transcription', () => {
    const { container } = render(<Results run={run()} />); expect(screen.getByText('AI-PROPOSED MARKS')).toBeInTheDocument(); expect(screen.getByText(/80%/)).toBeInTheDocument(); expect(screen.getByText('Read-only transcription')).toBeInTheDocument(); expect(container.querySelector('.katex')).toBeInTheDocument(); expect(container.querySelector('math')).not.toBeNull();
  });
  it('shows a subtotal and review flags without a final percentage', () => {
    render(<Results run={run(true)} />); expect(screen.getByText('GRADED SUBTOTAL')).toBeInTheDocument(); expect(screen.getByText('Ambiguous symbol')).toBeInTheDocument(); expect(screen.queryByText(/80%/)).not.toBeInTheDocument(); expect(screen.getByText(/Final total and percentage are withheld/)).toBeInTheDocument();
  });
  it('shows no marks finalised instead of a misleading zero for an all-pending run', () => {
    const { container } = render(<Results run={run(true)} />);
    expect(screen.getByText('No marks finalised')).toBeInTheDocument();
    expect(container.querySelector('.score')?.textContent).not.toContain('0');
  });
  it('shows an inferred mapping and verified reading beside unchanged raw transcription', () => {
    const value = run();
    value.transcription!.answers[0].identifier = '6';
    value.resolution = { mappings: [{ entryId: 'entry-1', questionId: '1', candidateQuestionIds: ['1'], evidence: 'Continuous working on page 1.' }], readings: [{ entryId: 'entry-1', originalText: '2', revisedText: '3', sourcePages: [1], evidence: 'Visible shape of digit 3.' }], warnings: [] };
    render(<Results run={value} />);
    expect(screen.getByText(/Mapped to question 1 from an ambiguous label/)).toBeInTheDocument();
    expect(screen.getByText(/Source label 6/)).toBeInTheDocument();
    expect(screen.getByText('Original: 2')).toBeInTheDocument();
    expect(screen.getByText('Re-read: 3')).toBeInTheDocument();
  });
  it('retains a graded subtotal when only some questions are pending', () => {
    const value = run();
    value.results.push({ ...value.results[0], identifier: '2', marks: null, status: 'needs_review', reviewFlags: ['Unclear final amount'] });
    value.totals = { maximumMarks: 10, gradedSubtotal: 4, totalMarks: null, percentage: null, pendingQuestions: ['2'] };
    const { container } = render(<Results run={value} />);
    expect(container.querySelector('.score')?.textContent).toContain('4');
    expect(screen.queryByText('No marks finalised')).not.toBeInTheDocument();
    expect(screen.getByText(/Pending review: 2/)).toBeInTheDocument();
  });
  it('shows an unnumbered continuation instead of displaying a literal null label', () => {
    const value = run(); value.transcription!.answers[0].identifier = 'null';
    value.resolution = { mappings: [{ entryId: 'entry-1', questionId: '1', candidateQuestionIds: ['1'], evidence: 'Continuation on page 1.' }], readings: [], warnings: [] };
    render(<Results run={value} />);
    expect(screen.getByText(/Unnumbered answer content → Question 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Source label null/)).not.toBeInTheDocument();
  });
});
describe('Upload and progress UI', () => {
  it('uses retained exam PDFs with only a new answer sheet and keeps them after Start over', async () => {
    const retainedExam = { questionPaper: { name: 'saved-paper.pdf', size: 100, pages: 1 }, answerKey: { name: 'saved-key.pdf', size: 100, pages: 1 } };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(url === '/api/health' ? { configured: true, model: 'test-sol', retainedExam, limits: { maxFileBytes: 10485760, maxPages: 10 } } : init?.method === 'POST' ? { id: 'test', retainedExam } : { ...run(), examReused: true }), { status: init?.method === 'POST' ? 202 : 200 }));
    vi.stubGlobal('fetch', mock); render(<App />);
    await screen.findByText(/Saved: saved-paper.pdf/);
    expect(screen.getByRole('button', { name: /Evaluate answer sheet/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Handwritten answer sheet'), { target: { files: [new File(['pdf'], 'new-sheet.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: /Evaluate answer sheet/ }));
    await screen.findByText(/Saved exam specification and rubric reused/);
    const body = mock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as FormData;
    expect(body.get('questionPaper')).toBeNull(); expect(body.get('answerKey')).toBeNull(); expect(body.get('answerSheet')).toBeInstanceOf(File);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await screen.findByText(/Saved: saved-key.pdf/);
    expect(screen.getByRole('button', { name: /Evaluate answer sheet/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved exam' }));
    await waitFor(() => expect(screen.queryByText(/Saved: saved-paper.pdf/)).not.toBeInTheDocument());
    expect(mock.mock.calls.some(([url, init]) => url === '/api/exam' && init?.method === 'DELETE')).toBe(true);
  });
  it('sends an explicitly selected replacement key while retaining the question paper', async () => {
    const retainedExam = { questionPaper: { name: 'paper.pdf', size: 100, pages: 1 }, answerKey: { name: 'key.pdf', size: 100, pages: 1 } };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url === '/api/health' ? { configured: true, model: 'test-sol', retainedExam, limits: { maxFileBytes: 10485760, maxPages: 10 } } : init?.method === 'POST' ? { id: 'test' } : run()), { status: init?.method === 'POST' ? 202 : 200 }));
    vi.stubGlobal('fetch', mock); render(<App />); await screen.findByText(/Saved: key.pdf/);
    fireEvent.change(screen.getByLabelText('Answer key'), { target: { files: [new File(['new'], 'changed-key.pdf', { type: 'application/pdf' })] } });
    fireEvent.change(screen.getByLabelText('Handwritten answer sheet'), { target: { files: [new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: /Evaluate answer sheet/ }));
    await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const body = mock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as FormData;
    expect(body.get('questionPaper')).toBeNull(); expect((body.get('answerKey') as File).name).toBe('changed-key.pdf');
  });
  it('offers Ultrafast with the higher-cost hint and submits its selected profile', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url === '/api/health' ? { configured: true, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'sol-ultrafast'], limits: { maxFileBytes: 10485760, maxPages: 10 } } : init?.method === 'POST' ? { id: 'test' } : run()), { status: init?.method === 'POST' ? 202 : 200 }));
    vi.stubGlobal('fetch', mock); render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Evaluation model')).toBeEnabled());
    expect(screen.getByRole('option', { name: 'GPT-6.1 Sol · all stages · Ultrafast' })).toBeInTheDocument();
    expect(screen.getByLabelText('Evaluation model')).toHaveValue('gpt-6.1-sol');
    fireEvent.change(screen.getByLabelText('Evaluation model'), { target: { value: 'sol-ultrafast' } });
    expect(screen.getByText(/higher API cost/)).toBeInTheDocument();
    for (const label of ['Question paper', 'Answer key', 'Handwritten answer sheet']) fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['pdf'], 'test.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: /Evaluate answer sheet/ }));
    await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    expect((mock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as FormData).get('model')).toBe('sol-ultrafast');
  });
  it('defaults to mixed mode when the backend offers Luna reading and Sol grading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configured: true, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-luna', 'luna-sol'], limits: { maxFileBytes: 10485760, maxPages: 10 } }))));
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Evaluation model')).toHaveValue('luna-sol'));
    expect(screen.getByText(/Sol evaluates against that rubric/)).toBeInTheDocument();
  });
  it('defaults to Sol and sends the chosen Luna model with the three PDFs', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url === '/api/health' ? { configured: true, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-luna'], limits: { maxFileBytes: 10485760, maxPages: 10 } } : init?.method === 'POST' ? { id: 'test' } : run()), { status: init?.method === 'POST' ? 202 : 200 }));
    vi.stubGlobal('fetch', mock); render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Evaluation model')).toBeEnabled());
    expect(screen.getByLabelText('Evaluation model')).toHaveValue('gpt-6.1-sol');
    fireEvent.change(screen.getByLabelText('Evaluation model'), { target: { value: 'gpt-6-luna' } });
    for (const label of ['Question paper', 'Answer key', 'Handwritten answer sheet']) fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['pdf'], 'test.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: /Evaluate answer sheet/ }));
    await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const body = mock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as FormData;
    expect(body.get('model')).toBe('gpt-6-luna');
    expect(body.getAll('questionPaper')).toHaveLength(1);
  });
  it('reconnects after a temporary backend outage and clears the stale error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValue(new Response(JSON.stringify({ configured: true, model: 'test-sol', limits: { maxFileBytes: 10485760, maxPages: 10 } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText(/Reconnecting automatically/);
    await waitFor(() => expect(screen.queryByText(/Cannot reach the backend/)).not.toBeInTheDocument(), { timeout: 4500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10000);
  it('shows configuration guidance and prevents starting an unconfigured backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configured: false, model: '', limits: { maxFileBytes: 10485760, maxPages: 10 } }))));
    render(<App />); await screen.findByText(/The API is running/); expect(screen.getByRole('button', { name: /Evaluate answer sheet/ })).toBeDisabled();
  });
  it.each(['reading_documents', 'resolving_answers', 'evaluating', 'failed', 'expired'])('shows the %s state after uploading', async stage => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const responseRun = { ...run(), stage, error: stage === 'failed' ? { code: 'MODEL_TIMEOUT', message: 'The model call timed out.', stage: 'transcribing' } : null, results: [], totals: null };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url === '/api/health' ? { configured: true, model: 'test-sol', limits: { maxFileBytes: 10485760, maxPages: 10 } } : init?.method === 'POST' ? { id: 'test' } : stage === 'expired' ? { error: { message: 'Evaluation not found. Server restarted. Upload again.' } } : responseRun), { status: init?.method === 'POST' ? 202 : stage === 'expired' && url !== '/api/health' ? 404 : 200 })));
    render(<App />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    for (const label of ['Question paper', 'Answer key', 'Handwritten answer sheet']) fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['pdf'], 'test.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Evaluate answer sheet/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Evaluate answer sheet/ }));
    if (stage === 'expired') {
      await screen.findByText(/Server restarted/);
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Return to uploads' }));
      expect(screen.getByRole('heading', { name: 'Upload your exam' })).toBeInTheDocument();
      expect(screen.queryByText(/Server restarted/)).not.toBeInTheDocument();
    }
    else if (stage === 'failed') { await screen.findByText(/The model call timed out/); expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument(); }
    else { await screen.findByRole('heading', { name: stage === 'reading_documents' ? 'Read exam & key + transcribe handwriting' : stage === 'resolving_answers' ? 'Resolve answer mapping' : 'Evaluate answers' }); expect(screen.getByText(/Processing can take several minutes/)).toBeInTheDocument(); }
  });
});
