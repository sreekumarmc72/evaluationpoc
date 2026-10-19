import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { RunSchema, uploadFields, selectableModels, modelLabels, isTerminal, displayedTotals, type EvaluationRun, type UploadField, type QuestionResult } from '@poc/shared';

type RetainedExam = Record<'questionPaper' | 'answerKey', { name: string; size: number; pages: number }>;
type Health = { configured: boolean; model: string; models?: string[]; retainedExam?: RetainedExam | null; limits: { maxFileBytes: number; maxPages: number } };
const labels: Record<UploadField, string> = { questionPaper: 'Question paper', answerKey: 'Answer key', answerSheet: 'Handwritten answer sheet' };
const hints: Record<UploadField, string> = { questionPaper: 'Questions and marks for every question', answerKey: 'Expected answers and marking criteria', answerSheet: 'One student’s scanned answers' };
const steps = ['validating', 'extracting_exam', 'transcribing', 'resolving_answers', 'evaluating'] as const;
const stageLabels: Record<string, string> = { validating: 'Check PDFs', reading_documents: 'Read exam & key + transcribe handwriting', extracting_exam: 'Read exam & key', transcribing: 'Transcribe handwriting', resolving_answers: 'Resolve answer mapping', evaluating: 'Evaluate answers', completed: 'Evaluation complete', failed: 'Evaluation stopped' };
const number = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(n);
class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.method === 'POST' ? 60000 : 15000);
  try {
  const response = await fetch(url, { ...init, signal: controller.signal });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error?.message ?? 'The request failed. Please try again.', response.status);
  return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The backend request timed out. Check that it is running, then retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function MathText({ text }: { text: string }) {
  // Raw HTML is disabled. KaTeX trust stays false for untrusted student/model text.
  return <div className="math-text"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]} disallowedElements={['a', 'img', 'script', 'iframe', 'object', 'embed']} unwrapDisallowed>{text}</ReactMarkdown></div>;
}
function MarkReview({ result, onSave }: { result: QuestionResult; onSave: (id: string, marks: number, reason: string) => Promise<void> }) {
  const [marks, setMarks] = useState(String(result.teacherAdjustment?.marks ?? result.marks ?? result.provisionalMarks ?? ''));
  const [reason, setReason] = useState(result.teacherAdjustment?.reason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <details><summary>Review or adjust marks</summary><form className="mark-review" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError('');
    try { await onSave(result.identifier, Number(marks), reason); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save marks.'); } finally { setSaving(false); }
  }}>
    <label>Marks for question {result.identifier}<input type="number" min="0" max={result.maximumMarks} step="any" required value={marks} onChange={e => setMarks(e.target.value)} /></label>
    <label>Review reason<input required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <button disabled={saving}>{saving ? 'Saving…' : 'Save reviewed marks'}</button>
    {error && <p role="alert">{error}</p>}
  </form></details>;
}
export function Results({ run, onAdjust }: { run: EvaluationRun; onAdjust?: (id: string, marks: number, reason: string) => Promise<void> }) {
  const rawTotals = run.totals;
  const totals = rawTotals ? displayedTotals(rawTotals) : null;
  const noneFinalised = !!totals && run.results.length > 0 && run.results.every(r => r.marks === null && !r.teacherAdjustment);
  const provisional = totals?.totalMarks === null && totals.provisionalTotal != null;
  return <section aria-label="Evaluation results" className="results">
    {totals && <div className="score-banner">
      <div><span className="eyebrow">{provisional ? 'PROVISIONAL MARKS · REVIEW RECOMMENDED' : totals.totalMarks === null ? 'GRADED SUBTOTAL' : run.results.some(r => r.teacherAdjustment) ? 'REVIEWED MARKS' : 'AI-PROPOSED MARKS'}</span>
        <div className="score">{noneFinalised && !provisional ? 'No marks finalised' : <>{number(totals.totalMarks ?? (provisional ? totals.provisionalTotal! : totals.gradedSubtotal))} <span>/ {number(totals.maximumMarks)}</span></>}</div>
        <p>{totals.totalMarks === null ? `Pending review: ${totals.pendingQuestions.join(', ')}. ${provisional ? 'Provisional marks include tentative awards; they are not final.' : 'Final total and percentage are withheld.'}` : `${number(totals.percentage!)}% · All questions evaluated`}</p>
      </div><div className="score-note">Check the transcription and reasoning against the original scan before using these marks.</div>
    </div>}
    {totals && rawTotals && !(noneFinalised && !provisional) && <details className="total-calculation"><summary>Total calculation & rounding</summary><p>Original calculated {totals.totalMarks !== null ? 'total' : provisional ? 'provisional total' : 'graded subtotal'}: {number(rawTotals.totalMarks ?? (provisional ? rawTotals.provisionalTotal! : rawTotals.gradedSubtotal))} / {number(rawTotals.maximumMarks)}.</p><p>Only the displayed overall total is rounded: fractions below 0.5 round down, above 0.5 round up, and exactly 0.5 stays unchanged. The total never exceeds the maximum marks. Question marks, rubric awards and saved calculations retain their original precision.</p></details>}
    {run.warnings.length > 0 && <div className="notice"><strong>Notes from processing</strong><ul>{[...new Set(run.warnings)].map(w => <li key={w}>{w}</li>)}</ul></div>}
    {run.results.length > 0 && <div className="section-heading"><h2>Question-by-question</h2><span>{run.results.length} questions</span></div>}
    <div className="question-list">{run.results.map(result => {
      const q = run.exam?.questions.find(q => q.identifier === result.identifier);
      return <article className="question" key={result.identifier}>
        <div className="question-top"><h3>Question {result.identifier}</h3><div className={`mark ${result.status === 'needs_review' && !result.teacherAdjustment ? 'review' : ''}`}>{result.teacherAdjustment ? `${number(result.teacherAdjustment.marks)} / ${number(result.maximumMarks)} · Reviewed` : result.marks !== null ? `${number(result.marks)} / ${number(result.maximumMarks)}` : result.provisionalMarks != null ? `${number(result.provisionalMarks)} / ${number(result.maximumMarks)} · Provisional` : 'Needs review'}</div></div>
        {result.teacherAdjustment && <p className="muted">Teacher review: {result.teacherAdjustment.reason}. Original AI award: {result.marks ?? result.provisionalMarks ?? 'not assessable'}{result.marks === null && result.provisionalMarks != null ? ' (provisional)' : ''}.</p>}
        {q && <MathText text={q.text} />}
        <MathText text={result.justification} />
        {q?.rubric?.length && <details className="rubric"><summary>Marking rubric & how it was applied</summary>
          <p className="muted">{q.rubric.some(c => c.allocationBasis === 'inferred') ? 'AI-inferred rubric — not teacher-approved. Supplied marking rules and approved exam conventions remain authoritative.' : 'Mark allocations supplied in the answer key.'} Created from the question paper and key before reading this answer sheet.</p>
          <div className="rubric-table"><table><thead><tr><th>Criterion / key basis</th><th>Maximum</th><th>Awarded</th><th>Student evidence / deduction</th></tr></thead><tbody>{q.rubric.map(c => {
            const a = result.criterionAwards?.find(a => a.criterionId === c.id);
            return <tr key={c.id}><td><MathText text={c.description} /><small>{c.allocationBasis === 'inferred' ? 'AI-inferred allocation' : 'Supplied allocation'}</small><MathText text={c.keyAlignment} /><p>Expected: {c.expectedEvidence}</p></td><td>{number(c.maximumMarks)}</td><td>{a?.marks == null ? 'Not assessed' : number(a.marks)}</td><td>{a && <><MathText text={a.evidence} /><MathText text={a.reason} /><small>{a.sourceEntryIds.map(id => { const entry = run.transcription?.answers.find(e => e.entryId === id); return `${id}${entry ? ' · pages ' + entry.sourcePages.join(', ') : ''}`; }).join('; ')}</small></>}</td></tr>;
          })}</tbody></table></div>
          <p>Question marks are calculated from these criterion awards. Teacher adjustments are shown separately.</p>
        </details>}
        {onAdjust && run.stage === 'completed' && <MarkReview result={result} onSave={onAdjust} />}
        {result.notes.length > 0 && <div className="muted"><strong>Informational notes</strong><ul>{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>}
        <div className="points">{result.correctPoints.length > 0 && <div><h4>Correct points</h4><ul>{result.correctPoints.map((p, i) => <li key={i}><MathText text={p} /></li>)}</ul></div>}{result.missingPoints.length > 0 && <div><h4>Missing or incorrect</h4><ul>{result.missingPoints.map((p, i) => <li key={i}><MathText text={p} /></li>)}</ul></div>}</div>
        {result.reviewFlags.length > 0 && <div className="notice"><strong>{result.teacherAdjustment ? 'Original AI review recommendation' : 'Review recommended'}</strong><ul>{result.reviewFlags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
        {q && <details><summary>Answer key & marking basis</summary><MathText text={q.expectedAnswer} /><p className="muted">Marking basis: {q.gradingBasis === 'inferred' ? 'Inferred holistic partial credit; no detailed rubric supplied.' : 'Supplied rubric.'}</p>{q.markingCriteria.map((c, i) => <MathText key={i} text={c} />)}{q.acceptedAlternatives.length > 0 && <><h4>Accepted alternatives</h4>{q.acceptedAlternatives.map((a, i) => <MathText key={i} text={a} />)}</>}</details>}
      </article>;
    })}</div>
    {run.transcription && <section className="transcription"><div className="section-heading"><h2>What the model read</h2><span>Read-only transcription</span></div>
      <p className="muted">Pages inspected: {run.transcription.pagesRead.join(', ') || 'None'} · {run.transcription.allPagesRead ? 'Complete coverage' : 'Incomplete coverage'}</p>
      {run.transcription.answers.length === 0 && <p>No written answers were found.</p>}
      {run.transcription.answers.map(answer => {
        const mapping = run.resolution?.mappings.find(m => m.entryId === answer.entryId);
        const readings = run.resolution?.readings.filter(r => r.entryId === answer.entryId) ?? [];
        const sourceLabel = answer.identifier && answer.identifier !== 'null' ? answer.identifier : null;
        return <details key={answer.entryId}><summary>{sourceLabel ? `Source label ${sourceLabel}` : 'Unnumbered answer content'}{mapping?.questionId && mapping.questionId !== sourceLabel ? ` → Question ${mapping.questionId}` : ''} <span>Pages {answer.sourcePages.join(', ')}</span></summary>
          {mapping && <p className="muted">{mapping.questionId ? `Mapped to question ${mapping.questionId}${answer.identifier !== mapping.questionId ? ' from an ambiguous label, subpart, or continuation' : ''}` : `Mapping unresolved${mapping.candidateQuestionIds.length ? ': candidate questions ' + mapping.candidateQuestionIds.join(', ') : ''}`} · {mapping.evidence}</p>}
          <MathText text={answer.text} />
          {readings.map((r, i) => <div className="notice" key={i}><strong>Verified reading on pages {r.sourcePages.join(', ')}</strong><p>Original: {r.originalText}</p><p>Re-read: {r.revisedText}</p><p>{r.evidence}</p></div>)}
          {answer.uncertainties.length > 0 && <ul className="muted">{answer.uncertainties.map(u => <li key={u.id}>{u.description} · {u.impact === 'non_material' ? 'Non-material reading note' : 'Potentially affects marking'}</li>)}</ul>}
          {answer.unsupportedContent && <div className="notice">Unsupported content requires review.</div>}
        </details>;
      })}
    </section>}
    <details className="metadata"><summary>Processing details</summary><p>Model: {modelLabels[run.model] ?? run.model}{run.model === 'sol-ultrafast' ? ' (Ultrafast requested)' : ''} · Tokens: {number(run.usage.totalTokens)} ({number(run.usage.inputTokens)} input / {number(run.usage.outputTokens)} output)</p><ul>{Object.entries(run.stageDurations).map(([stage, ms]) => <li key={stage}>{stageLabels[stage]}: {(ms / 1000).toFixed(1)}s{run.stageModels?.[stage] ? ` · ${run.stageModels[stage]}` : ''}</li>)}</ul></details>
    {run.examReused && <p className="muted">Saved exam specification and rubric reused; no question-paper or answer-key model call was needed.</p>}
  </section>;
}
export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('gpt-6.1-sol');
  const [files, setFiles] = useState<Partial<Record<UploadField, File>>>({});
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [runId, setRunId] = useState<string | null>(() => {
    try { return sessionStorage.getItem('evaluation-run-id'); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [preview, setPreview] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const [runMissing, setRunMissing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [lastProgressCheck, setLastProgressCheck] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const hasDocument = (field: UploadField) => !!files[field] || (field !== 'answerSheet' && !!health?.retainedExam?.[field]);
  const pollFailures = useRef(0);
  useEffect(() => {
    try { if (runId) sessionStorage.setItem('evaluation-run-id', runId); else sessionStorage.removeItem('evaluation-run-id'); } catch { /* Storage may be disabled. */ }
  }, [runId]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await api<Health>('/api/health');
        if (cancelled) return;
        setHealth(next);
        if (next.models?.includes('luna-sol')) setSelectedModel('luna-sol');
        else if (selectableModels.some(id => id === next.model)) setSelectedModel(next.model);
        setError(previous => previous.startsWith('Cannot reach the backend.') ? '' : previous);
      } catch {
        if (cancelled) return;
        setError('Cannot reach the backend. Start both applications with npm run dev. Reconnecting automatically…');
        timer = setTimeout(() => { void check(); }, 3000);
      }
    };
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const file = files.answerSheet;
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [files.answerSheet]);
  useEffect(() => {
    if (!runId || (run && isTerminal(run.stage))) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = RunSchema.parse(await api<unknown>(`/api/evaluations/${runId}`));
        if (cancelled) return;
        pollFailures.current = 0; setPollError(''); setRun(next); setLastProgressCheck(Date.now());
        if (isTerminal(next.stage)) { setBusy(false); return; }
      } catch (e) {
        if (cancelled) return;
        pollFailures.current++;
        setPollError(e instanceof Error ? e.message : 'Unable to fetch progress.');
        if (e instanceof ApiError && e.status === 404) { setRunMissing(true); setBusy(false); return; }
        if (pollFailures.current >= 3) setBusy(false);
      }
      timer = setTimeout(() => { void poll(); }, pollFailures.current >= 3 ? 10000 : 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, run?.stage, pollAttempt]);
  const start = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setPollError('');
    if (!health?.configured) { setError('Configure OPENAI_API_KEY and OPENAI_MODEL in the backend .env, then restart and reload this page.'); return; }
    if (uploadFields.some(field => !hasDocument(field))) { setError('Choose the question paper, answer key and a new answer sheet before starting.'); return; }
    const form = new FormData();
    if (health.models?.length) form.append('model', selectedModel);
    for (const field of uploadFields) {
      const file = files[field];
      if (!file) continue; // Retained exam documents are supplied by the backend.
      if (!file.size || file.size > health.limits.maxFileBytes) { setError(`${labels[field]} must be non-empty and at most ${health.limits.maxFileBytes / 1024 / 1024} MB.`); return; }
      form.append(field, file);
    }
    setBusy(true);
    try { const response = await api<{ id: string; retainedExam?: RetainedExam | null }>('/api/evaluations', { method: 'POST', body: form }); if (response.retainedExam) setHealth(old => old ? { ...old, retainedExam: response.retainedExam } : old); pollFailures.current = 0; setRunId(response.id); }
    catch (e) { setBusy(false); setError(e instanceof Error ? e.message : 'Upload failed.'); }
  };
  const reset = async () => {
    if (runId) {
      try { await api(`/api/evaluations/${runId}`, { method: 'DELETE' }); }
      catch (e) { if (!(e instanceof ApiError && e.status === 404)) { setError(e instanceof Error ? e.message : 'Could not remove the run.'); return; } }
    }
    setRunId(null); setRun(null); setFiles({}); setError(''); setPollError(''); setRunMissing(false); formRef.current?.reset();
  };
  const clearExam = async () => {
    setError(''); setBusy(true);
    try { await api('/api/exam', { method: 'DELETE' }); setHealth(old => old ? { ...old, retainedExam: null } : old); setFiles(old => ({ answerSheet: old.answerSheet })); formRef.current?.reset(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not clear the saved exam.'); }
    finally { setBusy(false); }
  };
  return <div className="app-shell">
    <header><a className="brand" href="/" aria-label="Paperwise home"><span className="brand-icon">p</span>paperwise<span className="poc">POC</span></a><span className="local-tag"><i />Local workspace</span></header>
    <main>
      <div className="hero"><span className="eyebrow">HANDWRITTEN ANSWER SHEET EVALUATION</span><h1>From handwritten answers<br />to a clearer picture.</h1><p>One exam. One answer sheet. Upload your PDFs to transcribe the handwriting and evaluate answers against your key.</p></div>
      {!runId && <section className="upload-panel"><div className="section-heading"><h2>Upload your exam</h2><span>{health?.retainedExam ? 'Saved exam · choose a new answer sheet' : 'Three PDFs to get started'}</span></div>
        {health?.retainedExam && <div className="notice">Question paper and answer key are saved locally. Choose replacements below to change them, or <button type="button" className="secondary" disabled={busy} onClick={() => { void clearExam(); }}>Clear saved exam</button>. Only a new answer sheet is required.</div>}
        <form onSubmit={start} ref={formRef}><div className="upload-grid">{uploadFields.map((field, index) => { const retained = field === 'answerSheet' ? undefined : health?.retainedExam?.[field]; return <div className={`upload-card ${hasDocument(field) ? 'selected' : ''}`} key={field}><span className="file-number">0{index + 1}</span><label htmlFor={field}>{labels[field]}</label><p>{hints[field]}</p>{retained && <p className="muted">Saved: {retained.name} · {retained.pages} pages{files[field] ? ' · Replacement selected' : ' · Will reuse'}</p>}<input id={field} type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => { const f = e.target.files?.[0]; setFiles(old => ({ ...old, [field]: f })); setError(''); }} />{files[field] && <small>{files[field]!.name} · {(files[field]!.size / 1024 / 1024).toFixed(2)} MB · Ready to upload</small>}</div>; })}</div>
          <div className="model-choice"><label htmlFor="evaluation-model">Evaluation model</label><select id="evaluation-model" value={selectedModel} disabled={busy || !health?.models?.length} onChange={e => setSelectedModel(e.target.value)}>{selectableModels.filter(id => !health?.models?.length || health.models.includes(id)).map(id => <option key={id} value={id}>{modelLabels[id]}</option>)}</select><p className="muted">{selectedModel === 'luna-sol' ? 'Luna reads the exam, creates the rubric, transcribes and resolves answers. Sol evaluates against that rubric.' : selectedModel === 'sol-ultrafast' ? 'Sol handles every stage using Ultrafast processing at higher API cost. The grading rules are unchanged.' : 'The selected model is used for every stage.'} Speed and handwriting quality need comparison; under one minute is not guaranteed.</p></div>
          <div className="upload-footer"><p>PDF only · Up to {health ? health.limits.maxFileBytes / 1024 / 1024 : 10} MB and {health?.limits.maxPages ?? 10} pages each<br /><span>English text and mathematics · All questions must count toward the total</span></p><button type="submit" disabled={busy || !health?.configured || uploadFields.some(f => !hasDocument(f))}>{busy ? 'Checking PDFs…' : 'Evaluate answer sheet'} <span aria-hidden="true">→</span></button></div>
        </form>
      </section>}
      {health && !health.configured && <div className="notice">The API is running. Set OPENAI_API_KEY and OPENAI_MODEL in the backend .env, then restart and reload to enable evaluation.</div>}
      {error && <div role="alert" className="error">{error}</div>}
      {runId && <section className="progress-panel" aria-live="polite"><div className="section-heading"><h2>{run ? stageLabels[run.stage] : 'Checking PDFs'}</h2>{run && isTerminal(run.stage) && <button className="secondary" onClick={() => { void reset(); }}>Start over</button>}</div>
        <ol className="steps">{steps.map((stage, i) => { const current = run ? steps.indexOf(run.stage as typeof steps[number]) : 0; const parallel = run?.stage === 'reading_documents'; const complete = run?.stage === 'completed' || (parallel ? i === 0 : stage === 'extracting_exam' ? !!run?.exam : stage === 'transcribing' ? !!run?.transcription : current > i); return <li key={stage} className={complete ? 'done' : (parallel ? i === 1 || i === 2 : current === i) && run?.stage !== 'failed' ? 'current' : ''}><span>{complete ? '✓' : i + 1}</span>{stageLabels[stage]}</li>; })}</ol>
        {busy && <p className="muted">Processing can take several minutes. Keep this page open.{run && <> Elapsed: {Math.max(0, Math.floor((now - run.createdAt) / 1000))}s.</>}{lastProgressCheck && <> Backend checked {Math.max(0, Math.floor((now - lastProgressCheck) / 1000))}s ago.</>}</p>}
        {run?.error && <div role="alert" className="error"><strong>Stopped during {stageLabels[run.error.stage].toLowerCase()}.</strong> {run.error.message}</div>}
        {pollError && <div role="alert" className="error">{pollError} {!runMissing && <p>Progress connection interrupted; the backend may still be evaluating. Reconnecting automatically. Reconnect checks this same run without making another model call.</p>} {!busy && <>{!runMissing && <button className="secondary" onClick={() => { pollFailures.current = 0; setBusy(true); setPollAttempt(p => p + 1); }}>Reconnect</button>}<button className="secondary" onClick={() => { setRunId(null); setRun(null); setFiles({}); setPollError(''); setError(''); setRunMissing(false); setLastProgressCheck(null); formRef.current?.reset(); }}>Return to uploads</button></>}</div>}
      </section>}
      {run && <div className="results-layout"><Results run={run} onAdjust={async (id, marks, reason) => { const next = await api<unknown>(`/api/evaluations/${runId}/questions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks, reason }) }); setRun(RunSchema.parse(next)); }} />{(preview || runId) && <aside className="scan"><div className="section-heading"><h2>Original answer sheet</h2><a href={preview || `/api/evaluations/${runId}/answer-sheet`} target="_blank" rel="noreferrer">Open PDF ↗</a></div><iframe title="Original answer sheet PDF" src={preview || `/api/evaluations/${runId}/answer-sheet`} /></aside>}</div>}
      {!runId && <div className="how-it-works"><div><span>01 / READ</span><h3>Transcribe faithfully</h3><p>Handwriting and mathematical working are read separately from the answer key.</p></div><div><span>02 / COMPARE</span><h3>Evaluate the meaning</h3><p>Equivalent wording and correct steps can earn partial credit against your marking guidance.</p></div><div><span>03 / CHECK</span><h3>Make uncertainty visible</h3><p>Unclear content is flagged for review. You can inspect the transcription and proposed marks.</p></div></div>}
    </main><footer>Answer-sheet results expire after one hour; a server restart clears runs. The question paper and key stay saved locally until replaced or cleared. <span>Documents are sent to OpenAI for processing; cached exam extraction is reused.</span></footer>
  </div>;
}

