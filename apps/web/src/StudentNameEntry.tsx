import { useEffect, useRef, useState } from 'react';
import { RunSchema, type EvaluationRun } from '@poc/shared';

export function needsStudentName(run: EvaluationRun) {
  return !!run.durable && run.stage === 'completed' && !run.manualStudentName && !(run.transcription?.studentIdentity?.status === 'readable' && run.transcription.studentIdentity.name?.trim());
}
export function StudentNameForm({ run, onSaved, onSkip }: { run: EvaluationRun; onSaved: (run: EvaluationRun) => void; onSkip?: () => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <form className="exam-form student-name-form" onSubmit={async event => {
    event.preventDefault(); if (!name.trim() || busy) return;
    setBusy(true); setError(''); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/evaluations/${run.id}/student-name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }), signal: controller.signal });
      const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'Could not save the student name.');
      const updated = RunSchema.parse(value); if (updated.id !== run.id || updated.examId !== run.examId) throw new Error('The returned submission does not match this report.');
      onSaved(updated);
    } catch (error) { setError(controller.signal.aborted ? 'Saving timed out. Retry to save the name; your marks are unchanged.' : error instanceof Error ? error.message : 'Could not save the student name.'); }
    finally { clearTimeout(timeout); setBusy(false); }
  }}>
    <p className="muted">The student name could not be read clearly from the answer sheet. Enter it for the saved submission history. Marks will not change.</p>
    <label htmlFor={`student-name-${run.id}`}>Student name</label><input id={`student-name-${run.id}`} value={name} onChange={event => setName(event.target.value)} required maxLength={160} disabled={busy} autoFocus autoComplete="name" />
    <div className="exam-model-actions"><button disabled={busy || !name.trim()}>{busy ? 'Saving name…' : 'Save name'}</button>{onSkip && <button type="button" className="secondary" disabled={busy} onClick={onSkip}>Skip for now</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
export function StudentNamePrompt({ run, onSaved }: { run: EvaluationRun; onSaved: (run: EvaluationRun) => void }) {
  const key = `student-name-skipped:${run.id}`;
  const [skipped, setSkipped] = useState(() => { try { return sessionStorage.getItem(key) === 'true'; } catch { return false; } });
  const ref = useRef<HTMLDialogElement>(null); const needed = needsStudentName(run); const open = needed && !skipped;
  const skip = () => { setSkipped(true); try { sessionStorage.setItem(key, 'true'); } catch { /* Browser storage may be unavailable. */ } };
  useEffect(() => {
    if (!open) return; const dialog = ref.current!; const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.showModal(); return () => { dialog.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  if (run.manualStudentName) return <p className="muted">Student: <strong>{run.manualStudentName.name}</strong> · Manually entered</p>;
  if (!needed) return null;
  return <>{skipped && <p><button className="secondary" onClick={() => setSkipped(false)}>Add student name</button></p>}{open && <dialog ref={ref} className="rubric-modal exam-manage-modal" aria-labelledby="student-name-title" onCancel={event => { event.preventDefault(); skip(); }}><div className="rubric-modal-content"><div className="rubric-modal-heading"><h2 id="student-name-title">Enter student name</h2></div><div className="rubric-modal-body"><StudentNameForm run={run} onSaved={onSaved} onSkip={skip} /></div></div></dialog>}</>;
}
