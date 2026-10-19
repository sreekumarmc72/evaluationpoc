import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { PreparedExamSchema, RunSchema, ExamSchema, modelLabels, isTerminal, type PreparedExam, type Exam, type EvaluationRun } from '@poc/shared';
import { Results } from './App';
import { SubmissionHistory } from './SubmissionHistory';
import './exam-pages.css';
import './student-theme.css';

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
function Shell({ role, children, examId }: { role: 'Faculty' | 'Student'; children: React.ReactNode; examId?: string }) {
  const brand = <><span className="brand-icon">p</span>paperwise<span className="poc">POC</span></>;
  return <div className={`app-shell exam-pages ${role === 'Faculty' ? 'faculty-shell' : 'student-shell'}`}><header>{role === 'Student' ? <><div className="student-brand"><img src="/branding/nergy-vidya.svg" alt="Nergy Vidya" width="100" height="56" /><span className="student-product">Answer Sheet Evaluation</span></div>{examId && <span className="student-exam-id" title={examId}>Exam ID <strong>{examId.slice(0, 8)}</strong></span>}</> : <a className="brand" href="/">{brand}</a>}{role === 'Faculty' && <nav aria-label="Page navigation"><a href="/faculty" aria-current="page">Faculty</a><a href="/">Original POC</a></nav>}</header><main>{children}</main><footer>Exams and student submissions are saved on this server. Original POC runs remain temporary.<span>POC · Faculty access is protected on the hosted service.</span></footer></div>;
}
function ActionIcon({ kind }: { kind: 'copy' | 'open' | 'rubric' | 'check' | 'close' | 'refresh' }) {
  const paths = { copy: 'M9 9h11v11H9z M5 15H3V3h12v2', open: 'M14 3h7v7 M21 3L10 14 M10 3H3v18h18v-7', rubric: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7', check: 'M5 12l4 4L19 6', close: 'M6 6l12 12 M18 6L6 18', refresh: 'M20 7v5h-5 M20 12a8 8 0 1 1-2-6' };
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
function RubricModal({ detail, onClose, onModelSaved }: { detail: { metadata: PreparedExam; specification: Exam }; onClose: () => void; onModelSaved: (metadata: PreparedExam) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false); const [selectedModel, setSelectedModel] = useState(detail.metadata.model);
  const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState(''); const [saved, setSaved] = useState(false);
  const saveModel = async () => {
    setSaving(true); setSaveError(''); setSaved(false);
    try {
      const value = await request<{ metadata: unknown }>(`/api/exams/${detail.metadata.id}/model`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel }) });
      onModelSaved(PreparedExamSchema.parse(value.metadata)); setEditing(false); setSaved(true);
    } catch (error) { setSaveError(message(error)); } finally { setSaving(false); }
  };
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.showModal();
    return () => { dialog.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="rubric-modal" aria-labelledby="rubric-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="rubric-modal-content"><div className="rubric-modal-heading"><div><span className="eyebrow">EXAM DETAILS</span><h2 id="rubric-title">{detail.metadata.name}</h2><p className="muted">{detail.metadata.questionCount} questions · {detail.metadata.maximumMarks} marks · Preparation {(detail.metadata.durationMs / 1000).toFixed(1)}s · {detail.metadata.usage.totalTokens.toLocaleString()} tokens</p></div><button className="icon-action" aria-label="Close details" title="Close details" onClick={onClose} autoFocus><ActionIcon kind="close" /></button></div><div className="rubric-modal-body">
      <section className="exam-model-settings" aria-label="Evaluation model"><h3>Evaluation model</h3><p>{modelLabels[detail.metadata.model]}</p>
        {editing ? <><label htmlFor="exam-evaluation-model">Choose evaluation model</label><select id="exam-evaluation-model" value={selectedModel} disabled={saving} onChange={event => setSelectedModel(event.target.value as PreparedExam['model'])}>{(['gpt-6.1-sol', 'sol-ultrafast'] as const).map(model => <option key={model} value={model}>{modelLabels[model]}</option>)}</select><p className="muted">Applies to new submissions through the same student link. The existing questions and rubric are retained. Ultrafast has higher API cost.</p><div className="exam-model-actions"><button disabled={saving || selectedModel === detail.metadata.model} onClick={() => { void saveModel(); }}>{saving ? 'Saving…' : 'Save model'}</button><button className="secondary" disabled={saving} onClick={() => { setEditing(false); setSaveError(''); }}>Cancel</button></div></> : <button className="secondary" onClick={() => { setSelectedModel(detail.metadata.model); setEditing(true); setSaved(false); setSaveError(''); }}>Edit model</button>}
        <p className="muted">Rubric prepared using {modelLabels[detail.metadata.preparationModel ?? detail.metadata.model]}.</p>
        {saved && <p role="status">Model updated. New student submissions will use this model.</p>}{saveError && <p role="alert" className="error">{saveError}</p>}
      </section><Specification exam={detail.specification} /></div></div>
  </dialog>;
}
function SolChoice({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="model-choice"><label htmlFor="sol-processing">Processing option</label><select id="sol-processing" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>{['gpt-6.1-sol', 'sol-ultrafast'].map(id => <option value={id} key={id}>{modelLabels[id]}</option>)}</select><p className="muted">{value === 'sol-ultrafast' ? 'Ultrafast uses the same Sol model at higher API cost.' : 'Sol handles the reading and marking.'} Processing time varies with the documents.</p></div>;
}
function ExamText({ text }: { text: string }) { return <div className="math-text"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]} disallowedElements={['a', 'img', 'script', 'iframe', 'object', 'embed']} unwrapDisallowed>{text}</ReactMarkdown></div>; }
function Specification({ exam }: { exam: Exam }) {
  return <section aria-label="Prepared questions and rubrics"><h2>Prepared questions & marking rubric</h2><p className="muted">Inferred allocations are AI-generated, not teacher-approved. The saved rubric is fixed for student submissions.</p>{exam.warnings.length > 0 && <div className="notice"><ul>{exam.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}{exam.questions.map(question => <article className="question" key={question.identifier}><div className="question-top"><h3>Question {question.identifier}</h3><span className="mark">{question.maximumMarks} marks</span></div><ExamText text={question.text} /><details><summary>Expected answer & marking guidance</summary><ExamText text={question.expectedAnswer} />{[...question.markingCriteria, ...question.acceptedAlternatives].map((text, i) => <ExamText key={i} text={text} />)}</details><div className="rubric-table rubric"><table><thead><tr><th>Criterion</th><th>Maximum</th><th>Expected evidence / key basis</th></tr></thead><tbody>{question.rubric?.map(criterion => <tr key={criterion.id}><td><ExamText text={criterion.description} /><small>{criterion.allocationBasis === 'inferred' ? 'AI-inferred allocation' : 'Supplied allocation'}</small></td><td>{criterion.maximumMarks}</td><td><ExamText text={criterion.expectedEvidence} /><ExamText text={criterion.keyAlignment} /></td></tr>)}</tbody></table></div></article>)}</section>;
}
export function FacultyPage() {
  const [exams, setExams] = useState<PreparedExam[]>([]); const [name, setName] = useState(''); const [search, setSearch] = useState('');
  const [files, setFiles] = useState<Partial<Record<'questionPaper' | 'answerKey', File>>>({}); const [model, setModel] = useState('gpt-6.1-sol');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [copiedExam, setCopiedExam] = useState(''); const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  const [historyExam, setHistoryExam] = useState<PreparedExam | null>(null);
  const [storage, setStorage] = useState<{ totalBytes: number; availableBytes: number; usedBytes: number; unreadableRecords?: unknown[] } | null>(null);
  useEffect(() => { void request<{ storage: typeof storage }>('/api/storage').then(value => setStorage(value.storage)).catch(() => {}); }, []);
  const [detail, setDetail] = useState<{ metadata: PreparedExam; specification: Exam } | null>(null); const [detailLoading, setDetailLoading] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const refresh = async () => { try { setExams(await listExams()); setError(''); } catch (error) { setError(message(error)); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); return () => clearTimeout(copiedTimer.current); }, []);
  useEffect(() => { if (!exams.some(exam => exam.status === 'preparing')) return; const timer = setInterval(() => { void refresh(); }, 2000); return () => clearInterval(timer); }, [exams]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!files.questionPaper || !files.answerKey) return; setBusy(true); setError('');
    try {
      const body = new FormData(); body.append('name', name.trim()); body.append('model', model); body.append('questionPaper', files.questionPaper); body.append('answerKey', files.answerKey);
      await request('/api/exams', { method: 'POST', body }); setName(''); setFiles({}); setSearch(''); formRef.current?.reset(); await refresh();
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const showDetail = async (exam: PreparedExam) => {
    setDetailLoading(exam.id);
    try { const value = await request<{ metadata: unknown; specification: unknown }>(`/api/exams/${exam.id}`); setDetail({ metadata: PreparedExamSchema.parse(value.metadata), specification: ExamSchema.parse(value.specification) }); }
    catch (error) { setError(message(error)); } finally { setDetailLoading(''); }
  };
  const copyLink = async (id: string) => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/student/${id}`); clearTimeout(copiedTimer.current); setCopiedExam(id); copiedTimer.current = setTimeout(() => setCopiedExam(''), 2500); }
    catch { setError('Could not copy the link. Open the student page and copy its address.'); }
  };
  const filtered = exams.filter(exam => `${exam.name} ${exam.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Shell role="Faculty">
    <div className="faculty-heading"><div><span className="eyebrow">PREPARE ONCE · SHARE WITH STUDENTS</span><h1>Faculty workspace</h1><p>Prepare your exam and rubric, then share its student link.</p></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="faculty-workspace">
      <section className="upload-panel faculty-create" aria-labelledby="create-title"><h2 id="create-title">Create exam</h2><p className="muted">Upload the question paper and answer key.</p>
        <form ref={formRef} onSubmit={create} className="exam-form"><label htmlFor="exam-name">Exam name</label><input id="exam-name" required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Accounting — October" />
          <div className="upload-grid exam-upload-grid">{(['questionPaper', 'answerKey'] as const).map(field => <div className={`upload-card ${files[field] ? 'selected' : ''}`} key={field}><label htmlFor={field}>{field === 'questionPaper' ? 'Question paper' : 'Answer key'}</label><p>PDF document</p><input id={field} type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => setFiles(old => ({ ...old, [field]: event.target.files?.[0] }))} />{files[field] && <small title={files[field]!.name}>{files[field]!.name}</small>}</div>)}</div>
          <SolChoice value={model} onChange={setModel} disabled={busy} /><p className="muted faculty-form-note">This processing option also applies to student submissions. Create a new exam to change its documents or rubric.</p><button className="create-exam-button" disabled={busy || !name.trim() || !files.questionPaper || !files.answerKey}>{busy ? 'Uploading…' : 'Create exam'}</button>
        </form>
      </section>
      <section className="faculty-exams" aria-labelledby="exams-title"><div className="faculty-list-heading"><div><h2 id="exams-title">Your exams <span className="exam-count">{exams.length}</span></h2><p className="muted">Open an exam or copy its student link.</p></div><button className="icon-action" title="Refresh exams" aria-label="Refresh exams" onClick={() => { void refresh(); }}><ActionIcon kind="refresh" /></button></div>
        <div className="faculty-search"><input type="search" aria-label="Search exams" placeholder="Search by exam name or ID…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="faculty-exam-scroll" role="region" aria-label="Created exams" tabIndex={0}>
          {loading ? <p className="exam-empty">Loading exams…</p> : !exams.length ? <p className="exam-empty">No exams yet. Create your first exam using the form.</p> : !filtered.length ? <p className="exam-empty">No exams match your search.</p> : <table className="faculty-exam-table"><thead><tr><th>Exam</th><th>Status</th><th>Questions / Marks</th><th>Actions</th></tr></thead><tbody>{filtered.map(exam => <tr key={exam.id}><td><strong>{exam.name}</strong><span className="exam-row-meta">{exam.model === 'sol-ultrafast' ? 'Sol Ultrafast' : 'Sol'} · {new Date(exam.createdAt).toLocaleDateString()}</span><span className="exam-row-meta" title={exam.id}>ID {exam.id.slice(0, 8)}</span><details className="exam-source-files"><summary>Source files</summary><p>{exam.documents.questionPaper.name}<br />{exam.documents.answerKey.name}</p></details></td>
            <td><span className={`mark ${exam.status !== 'ready' ? 'review' : ''}`}>{exam.status === 'ready' ? 'Ready' : exam.status === 'preparing' ? 'Preparing' : 'Failed'}</span>{exam.status === 'preparing' && <small className="exam-row-meta" role="status">Creating rubric…</small>}{exam.error && <small role="alert" className="exam-row-error">{exam.error.message}</small>}</td>
            <td>{exam.status === 'ready' ? <><strong>{exam.questionCount} / {exam.maximumMarks}</strong><span className="exam-row-meta">questions / marks</span></> : <span className="muted">—</span>}</td>
            <td><div className="exam-row-actions"><button className="secondary history-action" onClick={() => setHistoryExam(exam)}>Submissions ({exam.submissionCount ?? 0})</button>{exam.status === 'ready' && <><button className={`icon-action ${copiedExam === exam.id ? 'copied' : ''}`} aria-label="Copy student link" title={copiedExam === exam.id ? 'Copied!' : 'Copy student link'} onClick={() => { void copyLink(exam.id); }}><ActionIcon kind={copiedExam === exam.id ? 'check' : 'copy'} /></button><a className="icon-action" href={`/student/${exam.id}`} target="_blank" rel="noopener noreferrer" aria-label="Open student page →" title="Open student exam in a new tab"><ActionIcon kind="open" /></a><button className="icon-action" aria-label="View questions & rubric" title="View questions & rubric" disabled={!!detailLoading} onClick={() => { void showDetail(exam); }}><ActionIcon kind="rubric" /></button>{copiedExam === exam.id && <small className="copy-feedback" role="status">Student link copied</small>}</>}{exam.status === 'failed' && <button className="secondary retry-exam" disabled={busy} onClick={async () => { setBusy(true); try { await request(`/api/exams/${exam.id}/prepare`, { method: 'POST' }); await refresh(); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}>Retry preparation</button>}</div></td>
          </tr>)}</tbody></table>}
        </div><p className="faculty-list-note">Student links become available when preparation is complete.</p>
      </section>
    </div>
    {historyExam && <SubmissionHistory exam={historyExam} onClose={() => { setHistoryExam(null); void refresh(); }} />}
    {storage && <p className={`storage-usage ${storage.availableBytes < 50 * 1024 * 1024 ? 'storage-low' : ''}`}>Server disk: {(storage.usedBytes / 1024 / 1024).toFixed(0)} MB used · {(storage.availableBytes / 1024 / 1024).toFixed(0)} MB available. Saved submissions are not automatically deleted.</p>}
    {!!storage?.unreadableRecords?.length && <p className="error" role="alert">{storage.unreadableRecords.length} saved submission records could not be loaded. Their files were preserved on disk. Contact the administrator before making changes.</p>}
    {detail && <RubricModal detail={detail} onClose={() => setDetail(null)} onModelSaved={metadata => { setDetail(current => current?.metadata.id === metadata.id ? { ...current, metadata } : current); setExams(current => current.map(exam => exam.id === metadata.id ? { ...metadata, submissionCount: exam.submissionCount } : exam)); }} />}
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
    } catch (error) { if (cancelled) return; setError(message(error)); if (error instanceof RequestError && [401, 404].includes(error.status)) { setMissing(true); setBusy(false); return; } }
    timer = setTimeout(() => { void poll(); }, 2000); };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, examId]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!sheet || exam?.status !== 'ready') return; setBusy(true); setError('');
    try { const body = new FormData(); body.append('answerSheet', sheet); const response = await request<{ id: string }>(`/api/exams/${encodeURIComponent(examId)}/evaluations`, { method: 'POST', body }); setRunId(response.id); }
    catch (error) { setError(message(error)); setBusy(false); }
  };
  const nextSheet = async () => { try { if (runId && !missing && !run?.durable) await request(`/api/evaluations/${runId}`, { method: 'DELETE' }); setRunId(null); setRun(null); setSheet(undefined); setMissing(false); setError(''); setBusy(false); } catch (error) { setError(message(error)); } };
  const stageLabels: Record<string, string> = { validating: 'Checking answer sheet', transcribing: 'Transcribing handwriting', resolving_answers: 'Resolving answer mapping', evaluating: 'Evaluating answers', completed: 'Evaluation complete', failed: 'Evaluation stopped' };
  return <Shell role="Student" examId={examId}><div className="hero"><span className="eyebrow">STUDENT · SUBMIT YOUR WORK</span><h1>{exam?.name ?? 'Your exam'}</h1><p>Upload your handwritten answer sheet. The questions, answer key, marking rubric and processing model are already configured by your faculty.</p>{exam?.status === 'ready' && <p className="student-exam-facts">{exam.questionCount} questions · {exam.maximumMarks} maximum marks</p>}</div>
    {unavailable ? <section className="upload-panel"><h2>Exam unavailable</h2><p>This exam link is invalid or the saved exam is no longer available. Ask your faculty for a current link.</p></section> : <>
    {!runId && <section className="upload-panel"><div className="section-heading"><h2>Submit answer sheet</h2><button className="secondary" onClick={() => { void refresh(); }} disabled={busy}>Refresh exam</button></div>{loading ? <p>Loading exam…</p> : exam?.status === 'preparing' ? <p role="status">This exam is still being prepared. Please try again when your faculty confirms it is ready.</p> : exam?.status === 'failed' ? <p>This exam is not ready for submissions. Please contact your faculty.</p> : exam?.status === 'ready' && <form className="exam-form" onSubmit={submit}><p className="muted">Fixed rubric version {exam.version}</p><div className="upload-card"><label htmlFor="student-sheet">Handwritten answer sheet</label><p>One scanned PDF. Question paper and answer key are already saved.</p><input id="student-sheet" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => setSheet(event.target.files?.[0])} />{sheet && <small>{sheet.name}</small>}</div><button disabled={busy || !sheet}>{busy ? 'Submitting…' : 'Submit for evaluation'}</button></form>}</section>}
    {runId && <section className="progress-panel" aria-live="polite"><div className="section-heading"><h2>{missing ? 'Submission expired' : stageLabels[run?.stage ?? 'validating'] ?? 'Processing answer sheet'}</h2>{(!busy && (missing || (run && isTerminal(run.stage)))) && <button className="secondary" onClick={() => { void nextSheet(); }}>New submission</button>}</div><p className="muted">{exam?.name ?? 'Prepared exam'} · The saved questions and rubric are reused; no exam extraction call is made.</p>{!missing && <StudentProgress run={run} />}{run?.error && <p className="error" role="alert">{run.error.message}</p>}</section>}
    {run?.durable && run.stage === 'completed' && <p className="notice submission-saved">Submission saved under this exam. Reference: {run.id}. Starting a new submission keeps this report in faculty history.</p>}
    {run && <div className="results-layout"><Results run={run} />{runId && <aside className="scan"><div className="section-heading"><h2>Original answer sheet</h2><a href={preview || `/api/evaluations/${runId}/answer-sheet`} target="_blank" rel="noreferrer">Open PDF ↗</a></div><iframe title="Original answer sheet PDF" src={preview || `/api/evaluations/${runId}/answer-sheet`} /></aside>}</div>}
    </>}
    {error && <div className="error" role="alert">{error}{runId && !missing && !unavailable && <p>Reconnecting to the same submission automatically. Do not resubmit while processing is in progress.</p>}</div>}
  </Shell>;
}
