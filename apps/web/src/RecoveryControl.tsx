import { useState } from 'react';
import { RunSchema, type EvaluationRun } from '@poc/shared';
export function RecoveryControl({ run, onUpdate }: { run: EvaluationRun; onUpdate(run: EvaluationRun): void }) {
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!run.recoveryAvailable || !run.examId) return null;
  const failed = run.stage === 'failed';
  if (failed && !['MODEL_TIMEOUT', 'MODEL_CONNECTION', 'MODEL_UNAVAILABLE', 'MODEL_RATE_LIMIT', 'MODEL_PENDING', 'MODEL_INCOMPLETE', 'PROCESSING_INTERRUPTED'].includes(run.error?.code ?? '')) return null;
  if (run.stage === 'completed') return null;
  return <section className="notice" aria-label="Evaluation recovery"><strong>{failed ? 'Resume saved evaluation' : 'Recovery is processing'}</strong>
    {failed && <><p>Saved successful AI responses will be reused with the original rubric and model. A timed-out request may have completed remotely; retrying an unknown outcome can incur additional cost.</p><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I understand and want to retry unresolved work.</label></>}
    <button className="secondary" disabled={busy || (failed && !confirmed)} onClick={async () => { setBusy(true); setError(''); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000); try {
      const url = failed ? `/api/exams/${run.examId}/submissions/${run.id}/retry` : `/api/evaluations/${run.id}`;
      const response = await fetch(url, { signal: controller.signal, ...(failed ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledgeUnknownOutcome: true }) } : {}) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? 'Could not recover this evaluation.');
      onUpdate(RunSchema.parse(body)); setConfirmed(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not recover this evaluation.'); } finally { clearTimeout(timer); setBusy(false); } }}>{busy ? 'Checking…' : failed ? 'Retry unresolved work' : 'Refresh recovery progress'}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
