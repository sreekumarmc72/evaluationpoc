import { useEffect, useRef, useState } from 'react';
import { RunSchema, SubmissionSummarySchema, isTerminal, modelLabels, type PreparedExam, type EvaluationRun, type SubmissionSummary } from '@poc/shared';
import { Results } from './App';

async function read<T>(url: string): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try { const response = await fetch(url, { signal: controller.signal }); const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'Could not load saved submissions.'); return value; }
  finally { clearTimeout(timeout); }
}
export function submissionScore(item: SubmissionSummary) {
  if (item.stage !== 'completed' || !item.totals) return '—'; const t = item.totals;
  if (t.totalMarks !== null) return `${t.totalMarks} / ${t.maximumMarks}`;
  if (t.provisionalTotal != null) return `${t.provisionalTotal} / ${t.maximumMarks} · Provisional`;
  return t.gradedSubtotal > 0 ? `${t.gradedSubtotal} / ${t.maximumMarks} · Subtotal` : 'No marks finalised';
}
export function SubmissionHistory({ exam, onClose }: { exam: PreparedExam; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<SubmissionSummary[]>([]); const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  const [report, setReport] = useState<EvaluationRun | null>(null); const [opening, setOpening] = useState(false);
  useEffect(() => { const dialog = ref.current!; const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.showModal(); return () => { dialog.close(); document.body.style.overflow = overflow; previous?.focus(); }; }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(0); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => { try {
      const value = await read<{ submissions: unknown[]; total: number }>(`/api/exams/${exam.id}/submissions?page=${page}&search=${encodeURIComponent(query)}`);
      if (cancelled) return; const rows = value.submissions.map(item => SubmissionSummarySchema.parse(item)); setItems(rows); setTotal(value.total); setError('');
      if (rows.some(item => !isTerminal(item.stage))) timer = setTimeout(() => { void load(); }, 3000);
    } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : 'Could not load saved submissions.'); } finally { if (!cancelled) setLoading(false); } };
    setLoading(true); void load(); return () => { cancelled = true; clearTimeout(timer); };
  }, [exam.id, page, query, revision]);
  return <dialog ref={ref} className="rubric-modal history-modal" aria-labelledby="history-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="rubric-modal-content"><div className="rubric-modal-heading"><div><span className="eyebrow">SAVED SUBMISSIONS</span><h2 id="history-title">{exam.name} — Submission history</h2><p className="muted">Each upload has a unique ID. Names are read from the scan when clear.</p></div><button className="secondary" onClick={onClose} autoFocus>Close submissions</button></div><div className="rubric-modal-body">
    {error && <p className="error" role="alert">{error}</p>}
    {report ? <><button className="secondary" onClick={() => setReport(null)}>← Back to submissions</button><div className="saved-report-heading"><h3>{report.transcription?.studentIdentity?.name || (report.transcription?.studentIdentity?.status === 'unclear' ? 'Name unclear' : 'Unnamed student')}</h3><p className="muted">Submission {report.id} · {new Date(report.createdAt).toLocaleString()} · {modelLabels[report.model] ?? report.model}</p>{report.transcription?.studentIdentity && <p className="muted">Name evidence: {report.transcription.studentIdentity.note} {report.transcription.studentIdentity.sourcePages.length > 0 && `Pages ${report.transcription.studentIdentity.sourcePages.join(', ')}`}</p>}{report.error && <p className="error">{report.error.message}</p>}</div><div className="results-layout"><Results run={report} /><aside className="scan"><div className="section-heading"><h2>Original answer sheet</h2><a href={`/api/evaluations/${report.id}/answer-sheet`} target="_blank" rel="noopener noreferrer">Open PDF ↗</a></div><iframe title="Saved answer sheet PDF" src={`/api/evaluations/${report.id}/answer-sheet`} /></aside></div></> : <>
    <div className="history-toolbar"><input type="search" aria-label="Search submissions" placeholder="Search student name or submission ID…" value={search} onChange={event => setSearch(event.target.value)} /><button className="secondary" onClick={() => setRevision(value => value + 1)}>Refresh submissions</button></div>
    {loading ? <p>Loading submissions…</p> : !items.length ? <p>{query ? 'No submissions match your search.' : 'No saved submissions yet. New uploads will appear here.'}</p> : <div className="history-table-scroll"><table className="faculty-exam-table"><thead><tr><th>Student / ID</th><th>Submitted</th><th>Status</th><th>Marks</th><th>Result</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong>{item.studentName || (item.nameStatus === 'unclear' ? 'Name unclear' : 'Unnamed student')}</strong><small className="exam-row-meta" title={item.id}>{item.id.slice(0, 8)}</small></td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.interrupted ? 'Interrupted' : item.stage === 'completed' ? 'Completed' : item.stage === 'failed' ? 'Failed' : 'Processing'}{item.totals?.pendingQuestions.length ? <small className="exam-row-meta">Review: {item.totals.pendingQuestions.join(', ')}</small> : null}</td><td>{submissionScore(item)}</td><td><button className="secondary" disabled={opening} onClick={async () => { setOpening(true); try { const run = RunSchema.parse(await read(`/api/evaluations/${item.id}`)); if (run.examId !== exam.id) throw new Error('Submission does not belong to this exam.'); setReport(run); setError(''); } catch (error) { setError(error instanceof Error ? error.message : 'Could not load result.'); } finally { setOpening(false); } }}>View result</button></td></tr>)}</tbody></table></div>}
    <div className="history-pagination"><span>{total} saved submissions</span><button className="secondary" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page + 1}</span><button className="secondary" disabled={(page + 1) * 50 >= total || loading} onClick={() => setPage(value => value + 1)}>Next</button></div>
    </>}
  </div></div></dialog>;
}
