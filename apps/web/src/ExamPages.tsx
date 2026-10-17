import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { PreparedExamSchema, RunSchema, ExamSchema, modelLabels, isTerminal, type PreparedExam, type Exam, type EvaluationRun } from '@poc/shared';
import { Results } from './App';
import './exam-pages.css';

const studentStages = [
  { stage: 'validating', label: 'Check answer-sheet PDF' },
  { stage: 'transcribing', label: 'Transcribe handwriting' },
  { stage: 'resolving_answers', label: 'Resolve answer mapping', optional: true },
  { stage: 'evaluating', label: 'Evaluate answers' },
];

export function StudentProgress({ run }: { run: EvaluationRun | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || isTerminal(run.stage)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.stage]);
  const elapsed = run ? Math.max(0, Math.floor(((isTerminal(run.stage) ? run.finishedAt ?? now : now) - run.createdAt) / 1000)) : null;
  const failed = run?.stage === 'failed';
  const currentStage = failed ? run.error?.stage : run?.stage ?? 'validating';
  const currentIndex = run?.stage === 'completed' ? studentStages.length : studentStages.findIndex(step => step.stage === currentStage);
  return <><ol className="steps student-steps" aria-label="Answer evaluation progress">
    {studentStages.map((step, index) => {
      const passed = index < currentIndex;
      const skipped = passed && step.optional && run?.stageDurations.resolving_answers === undefined;
      const active = index === currentIndex;
      const status = skipped ? 'Skipped — not needed' : passed ? 'Completed' : active ? failed ? 'Stopped' : 'In progress' : failed ? 'Not started' : 'Waiting';
      const className = skipped ? 'skipped' : passed ? 'done' : active ? failed ? 'stopped' : 'current' : 'waiting';
      return <li key={step.stage} className={className} aria-current={active && !failed ? 'step' : undefined}>
        <span aria-hidden="true">{skipped ? '−' : passed ? '✓' : active && failed ? '!' : index + 1}</span>
        <div><strong>{step.label}</strong><small>{status}</small></div>
      </li>;
    })}
  </ol>{elapsed !== null && <p className="muted" role="timer" aria-live="off">Elapsed: {elapsed}s.{!isTerminal(run!.stage) && ' Processing can take several minutes. Keep this page open.'}</p>}</>;
}

class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), init?.method === 'POST' ? 60000 : 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status === 204) return undefined as T;
    const value = await response.json(); if (!response.ok) throw new RequestError(value.error?.message ?? 'Request failed.', response.status); return value;
  } catch (error) { if (controller.signal.aborted) throw new Error('The backend request timed out. Check the connection before submitting again.'); throw error; }
  finally { clearTimeout(timeout); }
}
async function listExams() { const value = await request<{ exams: unknown[] }>('/api/exams'); return value.exams.map(exam => PreparedExamSchema.parse(exam)); }
function message(error: unknown) { return error instanceof Error ? error.message : 'Cannot reach the backend. Check that both applications are running.'; }
function Shell({ role, children }: { role: 'Faculty' | 'Student'; children: React.ReactNode }) {
  return <div className="app-shell exam-pages"><header><a className="brand" href="/"><span className="brand-icon">p</span>paperwise<span className="poc">POC</span></a><nav aria-label="Page navigation"><a href="/faculty" aria-current={role === 'Faculty' ? 'page' : undefined}>Faculty</a><a href="/student" aria-current={role === 'Student' ? 'page' : undefined}>Student</a><a href="/">Original POC</a></nav></header><main>{children}</main><footer>Local POC · Exams are saved on this server. Answer sheets and results are temporary.<span>Faculty and Student are views; authentication is not enabled.</span></footer></div>;
}
function SolChoice({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="model-choice"><label htmlFor="sol-processing">Processing option</label><select id="sol-processing" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>{['gpt-6.1-sol', 'sol-ultrafast'].map(id => <option value={id} key={id}>{modelLabels[id]}</option>)}</select><p className="muted">{value === 'sol-ultrafast' ? 'Ultrafast uses the same Sol model at higher API cost.' : 'Sol handles the reading and marking.'} Processing time varies with the documents.</p></div>;
}
function ExamText({ text }: { text: string }) { return <div className="math-text"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]} disallowedElements={['a', 'img', 'script', 'iframe', 'object', 'embed']} unwrapDisallowed>{text}</ReactMarkdown></div>; }
function Specification({ exam }: { exam: Exam }) {
  return <section aria-label="Prepared questions and rubrics"><h2>Prepared questions & marking rubric</h2><p className="muted">Inferred allocations are AI-generated, not teacher-approved. The saved rubric is fixed for student submissions.</p>{exam.warnings.length > 0 && <div className="notice"><ul>{exam.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}{exam.questions.map(question => <article className="question" key={question.identifier}><div className="question-top"><h3>Question {question.identifier}</h3><span className="mark">{question.maximumMarks} marks</span></div><ExamText text={question.text} /><details><summary>Expected answer & marking guidance</summary><ExamText text={question.expectedAnswer} />{[...question.markingCriteria, ...question.acceptedAlternatives].map((text, i) => <ExamText key={i} text={text} />)}</details><div className="rubric-table rubric"><table><thead><tr><th>Criterion</th><th>Maximum</th><th>Expected evidence / key basis</th></tr></thead><tbody>{question.rubric?.map(criterion => <tr key={criterion.id}><td><ExamText text={criterion.description} /><small>{criterion.allocationBasis === 'inferred' ? 'AI-inferred allocation' : 'Supplied allocation'}</small></td><td>{criterion.maximumMarks}</td><td><ExamText text={criterion.expectedEvidence} /><ExamText text={criterion.keyAlignment} /></td></tr>)}</tbody></table></div></article>)}</section>;
}
export function FacultyPage() {
  const [exams, setExams] = useState<PreparedExam[]>([]); const [name, setName] = useState('');
  const [files, setFiles] = useState<Partial<Record<'questionPaper' | 'answerKey', File>>>({}); const [model, setModel] = useState('gpt-6.1-sol');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [copiedExam, setCopiedExam] = useState('');
  const [detail, setDetail] = useState<{ metadata: PreparedExam; specification: Exam | null } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const refresh = async () => { try { setExams(await listExams()); setError(''); } catch (error) { setError(message(error)); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!exams.some(exam => exam.status === 'preparing')) return; const timer = setInterval(() => { void refresh(); }, 2000); return () => clearInterval(timer); }, [exams]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!files.questionPaper || !files.answerKey) return; setBusy(true); setError('');
    try {
      const body = new FormData(); body.append('name', name.trim()); body.append('model', model); body.append('questionPaper', files.questionPaper); body.append('answerKey', files.answerKey);
      await request('/api/exams', { method: 'POST', body }); setName(''); setFiles({}); formRef.current?.reset(); await refresh();
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <Shell role="Faculty"><div className="hero"><span className="eyebrow">FACULTY · PREPARE ONCE</span><h1>Create an exam.<br />Keep its marking consistent.</h1><p>Upload the question paper and answer key. Sol prepares the questions and rubric before students submit their answer sheets.</p></div>
    <section className="upload-panel"><h2>Create exam</h2><form ref={formRef} onSubmit={create} className="exam-form"><label htmlFor="exam-name">Exam name</label><input id="exam-name" required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Accounting — October assessment" /><div className="upload-grid exam-upload-grid">{(['questionPaper', 'answerKey'] as const).map(field => <div className="upload-card" key={field}><label htmlFor={field}>{field === 'questionPaper' ? 'Question paper' : 'Answer key'}</label><p>{field === 'questionPaper' ? 'Questions and maximum marks' : 'Expected answers and marking guidance'}</p><input id={field} type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => setFiles(old => ({ ...old, [field]: event.target.files?.[0] }))} />{files[field] && <small>{files[field]!.name}</small>}</div>)}</div><SolChoice value={model} onChange={setModel} disabled={busy} /><div className="upload-footer"><p>PDF limits follow the existing POC configuration.<br />Create a new exam to change its documents or rubric.</p><button disabled={busy || !name.trim() || !files.questionPaper || !files.answerKey}>{busy ? 'Uploading…' : 'Create exam'}</button></div></form></section>
    {error && <div className="error" role="alert">{error}</div>}<section className="exam-list"><div className="section-heading"><h2>Your exams</h2><button className="secondary" onClick={() => { void refresh(); }}>Refresh exams</button></div>{loading ? <p>Loading exams…</p> : !exams.length ? <p className="muted">No exams yet. Create your first exam above.</p> : exams.map(exam => <article className="question" key={exam.id}><div className="question-top"><h3>{exam.name}</h3><span className={`mark ${exam.status !== 'ready' ? 'review' : ''}`}>{exam.status === 'ready' ? 'Ready' : exam.status === 'preparing' ? 'Preparing' : 'Failed'}</span></div><p className="muted">Created {new Date(exam.createdAt).toLocaleString()} · {modelLabels[exam.model]} · Exam {exam.id.slice(0, 8)}</p><p>{exam.documents.questionPaper.name} + {exam.documents.answerKey.name}</p>{exam.status === 'preparing' && <p role="status">Reading the exam and creating its rubric. This exam will become available to students when ready.</p>}{exam.status === 'ready' && <p>{exam.questionCount} questions · {exam.maximumMarks} maximum marks · Preparation {(exam.durationMs / 1000).toFixed(1)}s · {exam.usage.totalTokens.toLocaleString()} tokens</p>}{exam.error && <p role="alert" className="error">{exam.error.message}</p>}<div className="exam-actions">{exam.status === 'ready' && <button className="secondary" onClick={async () => { try { const value = await request<{ metadata: unknown; specification: unknown }>(`/api/exams/${exam.id}`); setDetail({ metadata: PreparedExamSchema.parse(value.metadata), specification: value.specification ? ExamSchema.parse(value.specification) : null }); } catch (error) { setError(message(error)); } }}>View questions & rubric</button>}{exam.status === 'failed' && <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await request(`/api/exams/${exam.id}/prepare`, { method: 'POST' }); await refresh(); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}>Retry preparation</button>}{exam.status === 'ready' && <><a href={`/student/${exam.id}`}>Open student page →</a><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(`${window.location.origin}/student/${exam.id}`); setCopiedExam(exam.id); } catch { setError('Could not copy the link. Copy it from the student page address bar.'); } }}>Copy student link</button>{copiedExam === exam.id && <span role="status">Student link copied</span>}</>}</div></article>)}</section>
    {detail?.specification && <section className="exam-detail"><div className="section-heading"><h2>{detail.metadata.name}</h2><button className="secondary" onClick={() => setDetail(null)}>Close details</button></div><Specification exam={detail.specification} /></section>}
  </Shell>;
}
export function studentExamIdFromPath(pathname: string) {
  return /^\/student\/([^/]+)\/?$/.exec(pathname)?.[1] ?? '';
}
export function StudentPage({ examId = studentExamIdFromPath(window.location.pathname) }: { examId?: string }) {
  if (!examId) return <Shell role="Student"><div className="hero"><h1>Open your exam link.</h1><p>Please use the student link shared by your faculty to upload an answer sheet for the correct exam.</p></div></Shell>;
  return <StudentExam key={examId} examId={examId} />;
}
function StudentExam({ examId }: { examId: string }) {
  const storageKey = `student-run-id:${examId}`;
  const [exam, setExam] = useState<PreparedExam | null>(null); const [sheet, setSheet] = useState<File>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [runId, setRunId] = useState<string | null>(() => { try { return sessionStorage.getItem(storageKey); } catch { return null; } });
  const [run, setRun] = useState<EvaluationRun | null>(null); const [preview, setPreview] = useState(''); const [missing, setMissing] = useState(false);
  const refresh = async () => { try {
    const value = await request<{ metadata: unknown }>(`/api/exams/${encodeURIComponent(examId)}/student`);
    const metadata = PreparedExamSchema.parse(value.metadata);
    if (metadata.id !== examId) throw new Error('The returned exam does not match this link.');
    setExam(metadata); setUnavailable(false); setError('');
  } catch (error) { setError(message(error)); if (error instanceof RequestError && error.status === 404) { setUnavailable(true); setExam(null); } } finally { setLoading(false); } };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { try { if (runId) sessionStorage.setItem(storageKey, runId); else sessionStorage.removeItem(storageKey); } catch { /* Browser storage may be disabled. */ } }, [runId, storageKey]);
  useEffect(() => { if (!sheet) { setPreview(''); return; } const url = URL.createObjectURL(sheet); setPreview(url); return () => URL.revokeObjectURL(url); }, [sheet]);
  useEffect(() => {
    if (!runId) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>; setBusy(true);
    const poll = async () => { try {
      const next = RunSchema.parse(await request(`/api/evaluations/${runId}`)); if (cancelled) return;
      if (next.examId !== examId) { setRunId(null); setRun(null); setBusy(false); setError('The saved submission belongs to another exam. Please upload your answer sheet for this exam.'); return; }
      setRun(next); setError('');
      if (isTerminal(next.stage)) { setBusy(false); return; }
    } catch (error) { if (cancelled) return; setError(message(error)); if (error instanceof RequestError && error.status === 404) { setMissing(true); setBusy(false); return; } }
    timer = setTimeout(() => { void poll(); }, 2000); };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, examId]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!sheet || exam?.status !== 'ready') return; setBusy(true); setError('');
    try { const body = new FormData(); body.append('answerSheet', sheet); const response = await request<{ id: string }>(`/api/exams/${encodeURIComponent(examId)}/evaluations`, { method: 'POST', body }); setRunId(response.id); }
    catch (error) { setError(message(error)); setBusy(false); }
  };
  const nextSheet = async () => { try { if (runId && !missing) await request(`/api/evaluations/${runId}`, { method: 'DELETE' }); setRunId(null); setRun(null); setSheet(undefined); setMissing(false); setError(''); setBusy(false); } catch (error) { setError(message(error)); } };
  const stageLabels: Record<string, string> = { validating: 'Checking answer sheet', transcribing: 'Transcribing handwriting', resolving_answers: 'Resolving answer mapping', evaluating: 'Evaluating answers', completed: 'Evaluation complete', failed: 'Evaluation stopped' };
  return <Shell role="Student"><div className="hero"><span className="eyebrow">STUDENT · SUBMIT YOUR WORK</span><h1>{exam?.name ?? 'Your exam'}</h1><p>Upload your handwritten answer sheet. The questions, answer key, marking rubric and processing model are already configured by your faculty.</p>{exam?.status === 'ready' && <p>{exam.questionCount} questions · {exam.maximumMarks} maximum marks</p>}</div>
    {unavailable ? <section className="upload-panel"><h2>Exam unavailable</h2><p>This exam link is invalid or the saved exam is no longer available. Ask your faculty for a current link.</p></section> : <>
    {!runId && <section className="upload-panel"><div className="section-heading"><h2>Submit answer sheet</h2><button className="secondary" onClick={() => { void refresh(); }} disabled={busy}>Refresh exam</button></div>{loading ? <p>Loading exam…</p> : exam?.status === 'preparing' ? <p role="status">This exam is still being prepared. Please try again when your faculty confirms it is ready.</p> : exam?.status === 'failed' ? <p>This exam is not ready for submissions. Please contact your faculty.</p> : exam?.status === 'ready' && <form className="exam-form" onSubmit={submit}><p className="muted">Fixed rubric version {exam.version}</p><div className="upload-card"><label htmlFor="student-sheet">Handwritten answer sheet</label><p>One scanned PDF. Question paper and answer key are already saved.</p><input id="student-sheet" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => setSheet(event.target.files?.[0])} />{sheet && <small>{sheet.name}</small>}</div><button disabled={busy || !sheet}>{busy ? 'Submitting…' : 'Submit for evaluation'}</button></form>}</section>}
    {runId && <section className="progress-panel" aria-live="polite"><div className="section-heading"><h2>{missing ? 'Submission expired' : stageLabels[run?.stage ?? 'validating'] ?? 'Processing answer sheet'}</h2>{(!busy && (missing || (run && isTerminal(run.stage)))) && <button className="secondary" onClick={() => { void nextSheet(); }}>New submission</button>}</div><p className="muted">{exam?.name ?? 'Prepared exam'} · The saved questions and rubric are reused; no exam extraction call is made.</p>{!missing && <StudentProgress run={run} />}{run?.error && <p className="error" role="alert">{run.error.message}</p>}</section>}
    {run && <div className="results-layout"><Results run={run} />{runId && <aside className="scan"><div className="section-heading"><h2>Original answer sheet</h2><a href={preview || `/api/evaluations/${runId}/answer-sheet`} target="_blank" rel="noreferrer">Open PDF ↗</a></div><iframe title="Original answer sheet PDF" src={preview || `/api/evaluations/${runId}/answer-sheet`} /></aside>}</div>}
    </>}
    {error && <div className="error" role="alert">{error}{runId && !missing && !unavailable && <p>Reconnecting to the same submission automatically. Do not resubmit while processing is in progress.</p>}</div>}
  </Shell>;
}
