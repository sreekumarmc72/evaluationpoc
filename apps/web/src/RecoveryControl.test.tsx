// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { EvaluationRun } from '@poc/shared';
import { RecoveryControl } from './RecoveryControl';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const failed = { id: 'run', examId: 'exam', recoveryAvailable: true, stage: 'failed', error: { code: 'MODEL_TIMEOUT' } } as EvaluationRun;
describe('Faculty recovery', () => {
  it('requires acknowledgement, reports network errors and keeps the report intact', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Network unavailable')); vi.stubGlobal('fetch', fetch); const onUpdate = vi.fn();
    render(<RecoveryControl run={failed} onUpdate={onUpdate} />);
    const retry = screen.getByRole('button', { name: 'Retry unresolved work' }); expect(retry).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable'));
    expect(fetch).toHaveBeenCalledWith('/api/exams/exam/submissions/run/retry', expect.objectContaining({ method: 'POST', body: JSON.stringify({ acknowledgeUnknownOutcome: true }) }));
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it('does not offer recovery for historical reports without checkpoints or completed reports', () => {
    const { rerender, container } = render(<RecoveryControl run={{ ...failed, recoveryAvailable: false }} onUpdate={vi.fn()} />); expect(container).toBeEmptyDOMElement();
    rerender(<RecoveryControl run={{ ...failed, stage: 'completed' }} onUpdate={vi.fn()} />); expect(container).toBeEmptyDOMElement();
  });
});
