import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FacultyPage, StudentPage, StudentProgress, studentExamIdFromPath } from './ExamPages';
import { SubmissionHistory, submissionScore } from './SubmissionHistory';
import { StudentNamePrompt } from './StudentNameEntry';
import type { PreparedExam, EvaluationRun } from '@poc/shared';

const id = '11111111-1111-4111-8111-111111111111';
const exam = (status: PreparedExam['status'] = 'ready'): PreparedExam => ({ id, name: 'Accounting test', version: 1, status, model: 'gpt-6.1-sol', createdAt: 1, finishedAt: status === 'preparing' ? null : 2, documents: { questionPaper: { name: 'paper.pdf', pages: 1, sha256: 'a' }, answerKey: { name: 'key.pdf', pages: 1, sha256: 'b' } }, questionCount: 1, maximumMarks: 6, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 100, warnings: [], error: status === 'failed' ? { code: 'MODEL_REFUSAL', message: 'Preparation refused.' } : null });
const specification = { policyVersion: null, questions: [{ identifier: '1', text: 'Journal entry', maximumMarks: 6, expectedAnswer: 'Correct journal', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred', rubric: [{ id: 'R1', description: 'Accounts and amounts', maximumMarks: 6, expectedEvidence: 'Correct ledger', keyAlignment: 'Answer key', allocationBasis: 'inferred' }] }], optionalQuestions: false, issues: [], warnings: [] };
const result = (): EvaluationRun => ({ id: 'submission', examId: id, examVersion: 1, examReused: true, stage: 'completed', createdAt: 1, finishedAt: 2, exam: specification as EvaluationRun['exam'], transcription: null, resolution: null, resolvedTranscription: null, results: [{ identifier: '1', maximumMarks: 6, marks: 6, status: 'graded', justification: 'Correct accounts and amounts.', correctPoints: ['Correct journal'], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [], criterionAwards: [{ criterionId: 'R1', marks: 6, evidence: 'Correct journal', reason: 'Matches key', sourceEntryIds: [] }] }], totals: { maximumMarks: 6, gradedSubtotal: 6, totalMarks: 6, percentage: 100, pendingQuestions: [] }, warnings: [], error: null, model: 'gpt-6.1-sol', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, stageDurations: { transcribing: 100, evaluating: 100 } });
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
beforeEach(() => {
  // jsdom does not implement the browser's native modal dialog methods.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function chooseExamAction(label: string, examName = 'Accounting test') {
  fireEvent.click(screen.getAllByRole('button', { name: `More actions for ${examName}` })[0]);
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

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
describe('Manual student name', () => {
  it('lets faculty name an unnamed report and shows the saved name in history', async () => {
    let named = false; const original = { ...result(), id, durable: true };
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { named = true; return response({ ...original, manualStudentName: { name: 'Anu Thomas', updatedAt: 1 } }); }
      if (url.includes('/submissions')) return response({ submissions: [{ id, createdAt: 1, stage: 'completed', model: 'gpt-6.1-sol', totals: original.totals, studentName: named ? 'Anu Thomas' : null, nameSource: named ? 'manual' : 'unavailable', nameStatus: 'absent', interrupted: false, error: null }], total: 1 });
      return response(original);
    });
    vi.stubGlobal('fetch', mock); render(<SubmissionHistory exam={exam()} onClose={() => {}} />);
    await screen.findByText('Unnamed student'); fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    await screen.findByLabelText('Student name');
    fireEvent.change(screen.getByLabelText('Student name'), { target: { value: 'Anu Thomas' } }); fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByRole('heading', { name: 'Anu Thomas' });
    expect(screen.getByText('Manually entered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back to submissions/ }));
    await screen.findByText('Anu Thomas'); expect(screen.getByText('Manually entered')).toBeInTheDocument();
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it.each(['absent', 'unclear'] as const)('prompts for a %s name, saves it, and stops prompting', async status => {
    const original = { ...result(), durable: true, transcription: { answers: [], pagesRead: [1], allPagesRead: true, warnings: [], studentIdentity: { name: null, status, sourcePages: [1], note: 'No readable name' } } };
    const updated = { ...original, manualStudentName: { name: 'Anu Thomas', updatedAt: 1 } };
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => response(updated)); vi.stubGlobal('fetch', mock);
    function Harness() { const [run, setRun] = React.useState<EvaluationRun>(original); return <StudentNamePrompt run={run} onSaved={setRun} />; }
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Enter student name' });
    fireEvent.change(within(dialog).getByLabelText('Student name'), { target: { value: ' Anu Thomas ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await screen.findByText('Anu Thomas');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe('/api/evaluations/submission/student-name');
    expect(JSON.parse((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ name: 'Anu Thomas' });
    expect(original.results[0].marks).toBe(6);
  });
  it('allows skipping, remembers it for the session, and offers entry later', () => {
    const value = { ...result(), durable: true };
    const { unmount } = render(<StudentNamePrompt run={value} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount(); render(<StudentNamePrompt run={value} onSaved={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add student name' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('does not prompt for readable names, saved names, active or temporary runs', () => {
    const { rerender } = render(<StudentNamePrompt run={{ ...result(), durable: true, stage: 'transcribing' }} onSaved={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<StudentNamePrompt run={result()} onSaved={() => {}} />); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<StudentNamePrompt run={{ ...result(), durable: true, manualStudentName: { name: 'Saved Name', updatedAt: 1 } }} onSaved={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByText('Saved Name')).toBeInTheDocument();
    rerender(<StudentNamePrompt run={{ ...result(), durable: true, transcription: { answers: [], pagesRead: [1], allPagesRead: true, warnings: [], studentIdentity: { name: 'Read Name', status: 'readable', sourcePages: [1], note: 'Name field' } } }} onSaved={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps name entry available after a save failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'Could not save the student name.' } }, 507)));
    render(<StudentNamePrompt run={{ ...result(), durable: true }} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Student name'), { target: { value: 'Anu' } }); fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByRole('alert'); expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Student name')).toHaveValue('Anu'); expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
  });
});
describe('Faculty page', () => {
  it('shows compact actions and supports keyboard navigation, Escape and outside dismissal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/storage' ? { storage: null } : { exams: [exam()] })));
    render(<FacultyPage />);
    const trigger = await screen.findByRole('button', { name: 'More actions for Accounting test' });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submissions (0)' })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: 'Open student page →' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Copy student link' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger); fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('keeps source filenames available in a popup for failed exams', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/storage' ? { storage: null } : { exams: [exam('failed')] })));
    render(<FacultyPage />); await screen.findByText('Failed');
    chooseExamAction('Source files');
    const dialog = screen.getByRole('dialog', { name: 'Source files — Accounting test' });
    expect(within(dialog).getByText('paper.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('key.pdf')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close source files' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry preparation' })).toBeInTheDocument();
  });
  it('rounds existing history totals and preserves provisional, subtotal and unavailable labels', () => {
    const item = { id, createdAt: 1, stage: 'completed' as const, model: 'gpt-6.1-sol', totals: { ...result().totals!, maximumMarks: 25, gradedSubtotal: 24.75, totalMarks: 24.75 }, studentName: null, nameStatus: 'absent' as const, interrupted: false, error: null };
    expect(submissionScore(item)).toBe('25 / 25');
    expect(submissionScore({ ...item, totals: { ...item.totals, totalMarks: 21.25 } })).toBe('21 / 25');
    expect(submissionScore({ ...item, totals: { ...item.totals, totalMarks: 21.5 } })).toBe('21.5 / 25');
    expect(submissionScore({ ...item, totals: { ...item.totals, totalMarks: null, provisionalTotal: 21.75 } })).toBe('22 / 25 · Provisional');
    expect(submissionScore({ ...item, totals: { ...item.totals, totalMarks: null, gradedSubtotal: 0.25 } })).toBe('0 / 25 · Subtotal');
    expect(submissionScore({ ...item, totals: null })).toBe('—');
    expect(item.totals.totalMarks).toBe(24.75);
  });
  it('edits a title and retains the same student link', async () => {
    let title = exam().name;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { title = JSON.parse(init.body as string).name; return response({ metadata: { ...exam(), name: title } }); }
      return response(url === '/api/storage' ? { storage: null } : { exams: [{ ...exam(), name: title }] });
    });
    vi.stubGlobal('fetch', mock); render(<FacultyPage />); await screen.findByText('Ready');
    chooseExamAction('Edit title');
    const dialog = await screen.findByRole('dialog', { name: 'Edit exam title' });
    fireEvent.change(within(dialog).getByLabelText('Exam title'), { target: { value: 'Business exam' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save title' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Business exam')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Business exam' }));
    expect(screen.getByRole('menuitem', { name: 'Open student page →' })).toHaveAttribute('href', `/student/${id}`);
    expect(mock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[0]).toBe(`/api/exams/${id}`);
  });
  it('requires two deletion stages, the exact title and an acknowledgement', async () => {
    let deleted = false;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deleted = true; return response(null, 204); }
      return response(url === '/api/storage' ? { storage: null } : { exams: deleted ? [] : [{ ...exam(), submissionCount: 3 }] });
    });
    vi.stubGlobal('fetch', mock); render(<FacultyPage />); await screen.findByText('Ready');
    chooseExamAction('Delete');
    let dialog = await screen.findByRole('dialog', { name: 'Delete this exam?' });
    expect(within(dialog).getByText(/3 saved submissions/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    chooseExamAction('Delete');
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to confirmation' }));
    const remove = within(dialog).getByRole('button', { name: 'Delete exam' });
    expect(remove).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type the exact exam title to confirm'), { target: { value: exam().name } });
    expect(remove).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(remove).toBeEnabled(); fireEvent.click(remove);
    await screen.findByText('No exams yet. Create your first exam using the form.');
    const call = mock.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ confirmationId: id, confirmationName: exam().name, acknowledged: true });
  });
  it('keeps the deletion confirmation open when the server rejects deletion', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? response({ error: { message: 'An evaluation is already running.' } }, 409) : response(url === '/api/storage' ? { storage: null } : { exams: [exam()] })));
    render(<FacultyPage />); await screen.findByText('Ready');
    chooseExamAction('Delete');
    const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to confirmation' }));
    fireEvent.change(within(dialog).getByLabelText('Type the exact exam title to confirm'), { target: { value: exam().name } });
    fireEvent.click(within(dialog).getByRole('checkbox')); fireEvent.click(within(dialog).getByRole('button', { name: 'Delete exam' }));
    await within(dialog).findByText('An evaluation is already running.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('uses Nergy Vidya faculty branding and retains existing navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/storage' ? { storage: null } : { exams: [] })));
    render(<FacultyPage />);
    expect(screen.getByRole('link', { name: 'Nergy Vidya home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('img', { name: 'Nergy Vidya' })).toHaveAttribute('src', '/branding/nergy-vidya.svg');
    expect(screen.getByRole('link', { name: 'Original POC' })).toHaveAttribute('href', '/');
    await screen.findByText('No exams yet. Create your first exam using the form.');
  });
  it('opens saved submissions and displays the report, rubric and PDF', async () => {
    const summary = { id, createdAt: 1, stage: 'completed', model: 'gpt-6.1-sol', totals: result().totals, studentName: 'Anu Thomas', nameStatus: 'readable', interrupted: false, error: null };
    const mock = vi.fn(async (url: string) => response(url === '/api/storage' ? { storage: null } : url === '/api/exams' ? { exams: [{ ...exam(), submissionCount: 1 }] } : url.includes('/submissions') ? { submissions: [summary], total: 1 } : { ...result(), id }));
    vi.stubGlobal('fetch', mock); render(<FacultyPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submissions (1)' }));
    const dialog = await screen.findByRole('dialog'); await within(dialog).findByText('Anu Thomas');
    fireEvent.click(within(dialog).getByRole('button', { name: 'View result' }));
    await within(dialog).findByText('Marking rubric & how it was applied');
    expect(within(dialog).getByTitle('Saved answer sheet PDF')).toHaveAttribute('src', `/api/evaluations/${id}/answer-sheet`);
    fireEvent.click(within(dialog).getByRole('button', { name: /Back to submissions/ }));
    expect(within(dialog).getByText('Anu Thomas')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close submissions' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows a safe empty archive and does not label unresolved marks as zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ submissions: [], total: 0 })));
    render(<SubmissionHistory exam={exam()} onClose={() => {}} />);
    await screen.findByText('No saved submissions yet. New uploads will appear here.');
    expect(submissionScore({ id, createdAt: 1, stage: 'completed', model: 'gpt-6.1-sol', totals: { ...result().totals!, totalMarks: null, gradedSubtotal: 0, pendingQuestions: ['1'] }, studentName: null, nameStatus: 'absent', interrupted: false, error: null })).toBe('No marks finalised');
  });
  it('edits the model from the details popup and displays the persisted selection', async () => {
    const updated = { ...exam(), model: 'sol-ultrafast' as const, preparationModel: 'gpt-6.1-sol' as const };
    const mock = vi.fn(async (url: string, init?: RequestInit) => response(init?.method === 'PATCH' ? { metadata: updated } : url === '/api/exams' ? { exams: [exam()] } : { metadata: exam(), specification }));
    vi.stubGlobal('fetch', mock); render(<FacultyPage />); await screen.findByText('Ready');
    chooseExamAction('View questions & rubric');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Evaluation model' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit model' }));
    fireEvent.change(within(dialog).getByLabelText('Choose evaluation model'), { target: { value: 'sol-ultrafast' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save model' }));
    await within(dialog).findByText('Model updated. New student submissions will use this model.');
    const call = mock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(call[0]).toBe(`/api/exams/${id}/model`); expect(JSON.parse(call[1]!.body as string)).toEqual({ model: 'sol-ultrafast' });
    expect(screen.getByText(/Sol Ultrafast ·/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('filters exams by name or ID and reports an empty search result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ exams: [exam(), { ...exam(), id: '22222222-2222-4222-8222-222222222222', name: 'Business mathematics' }] })));
    render(<FacultyPage />); await screen.findByText('Business mathematics');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search exams' }), { target: { value: 'business' } });
    expect(screen.queryByText('Accounting test')).not.toBeInTheDocument();
    expect(screen.getByText('Business mathematics')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '11111111' } });
    expect(screen.getByText('Accounting test')).toBeInTheDocument();
    expect(screen.queryByText('Business mathematics')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
    expect(screen.getByText('No exams match your search.')).toBeInTheDocument();
  });
  it('closes rubric details on cancel and restores page scrolling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/exams' ? { exams: [exam()] } : { metadata: exam(), specification })));
    render(<FacultyPage />); await screen.findByText('Ready');
    chooseExamAction('View questions & rubric');
    const dialog = await screen.findByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });
  it('provides and copies a distinct student link only for a ready exam', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async () => response({ exams: [exam(), { ...exam('preparing'), id: '22222222-2222-4222-8222-222222222222' }] })));
    render(<FacultyPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'More actions for Accounting test' }))[0]);
    const link = screen.getByRole('menuitem', { name: 'Open student page →' });
    expect(link).toHaveAttribute('href', `/student/${id}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('menuitem', { name: 'Copy student link' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy student link' }));
    await screen.findByText('Student link copied');
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/student/${id}`);
  });
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
    chooseExamAction('View questions & rubric'); await screen.findByText('Accounts and amounts');
    expect(screen.getByText(/AI-generated, not teacher-approved/)).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Accounting test' });
    expect(within(dialog).getByText('Accounts and amounts')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preparation' }));
    await waitFor(() => expect(mock.mock.calls.some(([url, init]) => url.endsWith('/prepare') && init?.method === 'POST')).toBe(true));
  });
});
describe('Student page', () => {
  it('shows the saved student name in the profile and leaves without deleting or forgetting the submission', async () => {
    sessionStorage.setItem(`student-run-id:${id}`, 'submission');
    const value = { ...result(), durable: true, manualStudentName: { name: 'Anu Thomas', updatedAt: 1 } };
    const mock = vi.fn(async (url: string, _init?: RequestInit) => response(url.endsWith('/student') ? { metadata: exam() } : value));
    const navigate = vi.fn(); vi.stubGlobal('fetch', mock); render(<StudentPage examId={id} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Student profile: Anu Thomas' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/student?left=1'));
    expect(sessionStorage.getItem(`student-run-id:${id}`)).toBe('submission');
    expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE' || init?.method === 'POST')).toBe(false);
  });
  it('shows a neutral student exit page without clearing saved submission pointers or making API calls', () => {
    const original = window.location.href; window.history.replaceState({}, '', '/student?left=1');
    try {
      sessionStorage.setItem(`student-run-id:${id}`, 'submission'); const mock = vi.fn(); vi.stubGlobal('fetch', mock);
      render(<StudentPage examId="" />); expect(screen.getByRole('heading', { name: 'You have left the exam.' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Student profile/ })).not.toBeInTheDocument();
      expect(sessionStorage.getItem(`student-run-id:${id}`)).toBe('submission'); expect(mock).not.toHaveBeenCalled();
    } finally { window.history.replaceState({}, '', original); }
  });
  it('shows available and required question counts and public selection instructions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ metadata: { ...exam(), name: 'Cost accounting', questionCount: 6, requiredQuestionCount: 4, maximumMarks: 50, selectionInstructions: [{ sectionId: 'A', instructions: 'Answer any two. Each carries 10 marks.', requiredCount: 2, availableCount: 3, maximumMarks: 20 }] } })));
    render(<StudentPage examId={id} />);
    await screen.findByText(/6 questions available · 4 required/);
    expect(screen.getByRole('region', { name: 'Exam selection instructions' })).toHaveTextContent('Answer any two. Each carries 10 marks.');
    expect(screen.getByLabelText('Handwritten answer sheet')).toBeInTheDocument();
  });
  it('loads the URL exam without selectors and submits only the answer sheet', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    const mock = vi.fn(async (url: string, init?: RequestInit) => response(url.endsWith('/student') ? { metadata: exam() } : init?.method === 'POST' ? { id: 'submission' } : result(), init?.method === 'POST' ? 202 : 200));
    vi.stubGlobal('fetch', mock); render(<StudentPage examId={id} />); await screen.findByLabelText('Handwritten answer sheet');
    expect(screen.getByRole('heading', { name: 'Accounting test' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /paperwise/ })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Nergy Vidya' })).toHaveAttribute('src', '/branding/nergy-vidya.svg');
    expect(screen.getByText('Answer Sheet Evaluation')).toBeInTheDocument();
    expect(screen.getByTitle(id)).toHaveTextContent('Exam ID 11111111');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Correct journal')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Handwritten answer sheet'), { target: { files: [new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for evaluation' })); await screen.findByText('6 / 6');
    const [url, init] = mock.mock.calls.find(([, init]) => init?.method === 'POST')!; expect(url).toBe(`/api/exams/${id}/evaluations`);
    const body = init!.body as FormData; expect([...body.keys()]).toEqual(['answerSheet']);
    expect(screen.getByText('Marking rubric & how it was applied')).toBeInTheDocument(); expect(screen.queryByText('Review or adjust marks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New submission' })); await screen.findByLabelText('Handwritten answer sheet');
    expect(screen.getByRole('heading', { name: 'Accounting test' })).toBeInTheDocument();
  });
  it('asks for a faculty link on the bare student URL without listing exams', () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock); render(<StudentPage examId="" />);
    expect(screen.getByRole('heading', { name: 'Open your exam link.' })).toBeInTheDocument(); expect(mock).not.toHaveBeenCalled();
    expect(studentExamIdFromPath(`/student/${id}/`)).toBe(id);
    expect(studentExamIdFromPath('/student')).toBe('');
    expect(studentExamIdFromPath(`/student/${id}/other`)).toBe('');
  });
  it.each(['preparing', 'failed'] as const)('does not allow submissions to a %s exam', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ metadata: exam(status) })));
    render(<StudentPage examId={id} />); await screen.findByText(status === 'preparing' ? /still being prepared/ : /not ready for submissions/);
    expect(screen.queryByLabelText('Handwritten answer sheet')).not.toBeInTheDocument();
  });
  it('explains an invalid or expired exam link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'Exam not found.' } }, 404)));
    render(<StudentPage examId="invalid" />); await screen.findByRole('heading', { name: 'Exam unavailable' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('reconnects to the exam-scoped saved submission without posting again', async () => {
    sessionStorage.setItem(`student-run-id:${id}`, 'submission');
    const mock = vi.fn(async (url: string) => response(url.endsWith('/student') ? { metadata: exam() } : result())); vi.stubGlobal('fetch', mock);
    render(<StudentPage examId={id} />); await screen.findByText('6 / 6');
    expect(mock.mock.calls.every(([url]) => url === `/api/exams/${id}/student` || url === '/api/evaluations/submission')).toBe(true);
  });
  it('ignores another exam session and rejects a mismatched run response', async () => {
    sessionStorage.setItem('student-run-id:other-exam', 'other-submission');
    const mock = vi.fn(async (url: string) => response(url.endsWith('/student') ? { metadata: exam() } : { ...result(), examId: 'other-exam' }));
    vi.stubGlobal('fetch', mock); const view = render(<StudentPage examId={id} />); await screen.findByLabelText('Handwritten answer sheet');
    expect(mock.mock.calls.some(([url]) => url.includes('other-submission'))).toBe(false); view.unmount();
    sessionStorage.setItem(`student-run-id:${id}`, 'wrong-submission');
    render(<StudentPage examId={id} />); await screen.findByText(/saved submission belongs to another exam/);
    expect(screen.queryByText('6 / 6')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(`student-run-id:${id}`)).toBeNull();
  });
  it('resets safely when the run has expired, staying on the same exam', async () => {
    sessionStorage.setItem(`student-run-id:${id}`, 'expired');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/student') ? { metadata: exam() } : { error: { message: 'Submission expired.' } }, url.endsWith('/student') ? 200 : 404)));
    render(<StudentPage examId={id} />); await screen.findByRole('heading', { name: 'Submission expired' });
    fireEvent.click(screen.getByRole('button', { name: 'New submission' })); await screen.findByLabelText('Handwritten answer sheet');
    expect(sessionStorage.getItem(`student-run-id:${id}`)).toBeNull();
  });
});
