import { useEffect, useRef, useState } from 'react';

export function ReportDownload({ runId }: { runId: string }) {
  const [state, setState] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const download = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setState('preparing'); setError('');
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`/api/evaluations/${encodeURIComponent(runId)}/report.pdf`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'Access to this report has expired. Reopen your submission or sign in to faculty history.' : 'Could not download the report. Please try again.');
      if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('Could not download the report. Please try again.');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = `evaluation-${runId.replace(/[^a-zA-Z0-9-]/g, '')}.pdf`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      setState('ready');
    } catch (cause) {
      // Unmount cancellation should not update a result the user has left.
      if (controller.signal.aborted && active.current !== controller) return;
      setError(controller.signal.aborted ? 'The report is taking longer than expected. Please try again.' : cause instanceof Error ? cause.message : 'Could not download the report. Please try again.');
      setState('error');
    } finally { clearTimeout(timeout); if (active.current === controller) active.current = null; }
  };
  useEffect(() => () => { const controller = active.current; active.current = null; controller?.abort(); }, []);
  return <div className="report-download">
    <div className="section-heading"><h2>Evaluation report</h2><button type="button" className="secondary" disabled={state === 'preparing'} aria-busy={state === 'preparing'} onClick={() => { void download(); }}>{state === 'preparing' ? 'Preparing report…' : 'Download Evaluation Report'}</button></div>
    <p className="muted" role="status" aria-live="polite">{state === 'preparing' ? 'Preparing your PDF. This may take a few seconds.' : state === 'ready' ? 'Your report is ready. Check your browser’s downloads.' : state === 'idle' ? 'PDF · Marks, rubric and evaluation feedback.' : ''}</p>
    {state === 'error' && <p className="error" role="alert">{error}</p>}
  </div>;
}
