import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReportDownload } from './ReportDownload';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pdfResponse = () => ({ ok: true, headers: new Headers({ 'content-type': 'application/pdf' }), blob: async () => new Blob(['%PDF-test'], { type: 'application/pdf' }) });
describe('Evaluation report download', () => {
  it('shows immediate progress, prevents duplicate requests and downloads the returned PDF', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal('fetch', fetcher);
    const create = vi.fn(() => 'blob:report'), revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('evaluation-submission-1.pdf'); expect(this.href).toBe('blob:report');
    });
    render(<ReportDownload runId="submission-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Evaluation Report' }));
    const preparing = screen.getByRole('button', { name: 'Preparing report…' });
    expect(preparing).toBeDisabled(); expect(preparing).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Preparing your PDF');
    fireEvent.click(preparing); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/evaluations/submission-1/report.pdf', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => { resolve(pdfResponse()); });
    expect(click).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Check your browser’s downloads');
    expect(screen.getByRole('button', { name: 'Download Evaluation Report' })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(60000); }); expect(revoke).toHaveBeenCalledWith('blob:report');
  });
  it('shows an error and re-enables the button when the server rejects a download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    render(<ReportDownload runId="failed" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download Evaluation Report' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not download the report');
    expect(screen.getByRole('button', { name: 'Download Evaluation Report' })).toBeEnabled();
  });
  it('does not download an HTML login page as a PDF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) })));
    render(<ReportDownload runId="expired" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download Evaluation Report' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not download the report');
  });
  it('cancels a pending request when leaving the result', () => {
    const fetcher = vi.fn(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(<ReportDownload runId="leaving" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Evaluation Report' }));
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    unmount(); expect(signal.aborted).toBe(true);
  });
});
