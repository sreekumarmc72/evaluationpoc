import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type TaskRecord = { clientRequestId: string; responseId?: string; response?: unknown; qualityRejected?: boolean; artifact?: unknown; outcome: 'started' | 'received' | 'unknown' | 'failed'; updatedAt: string; task?: string; questionIds?: string[]; model?: string };
type Context = { runId: string; examId?: string; load(key: string): Promise<TaskRecord | null>; save(key: string, record: TaskRecord): Promise<void>; progress?(stage: string, draft?: import('@poc/shared').ExamBlueprint): Promise<void>; readingProgress?(value: import('@poc/shared').ReadingProgress): Promise<void> };
export const modelContext = new AsyncLocalStorage<Context>();
type RequestContext = { clientRequestId: string; task: string; questionIds: string[]; pageNumbers?: number[] };
export const requestContext = new AsyncLocalStorage<RequestContext>();
export const newClientRequestId = () => randomUUID();
export const recoveryVersion = process.env.RENDER_GIT_COMMIT || 'recovery-v1';
export function diagnostic(event: string, detail: Record<string, unknown> = {}) {
  const context = modelContext.getStore(); const request = requestContext.getStore();
  console.info(JSON.stringify({ event, timestamp: new Date().toISOString(), runId: context?.runId, examId: context?.examId, ...request, ...detail }));
}
// Log an allowlist of metadata only. Never log body, authorization, student text
// or raw exception messages (which can include request content).
export const diagnosticFetch: typeof fetch = async (input, init) => {
  const start = Date.now(); const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const attempt = Number(headers.get('x-stainless-retry-count') ?? 0) + 1;
  diagnostic('api_attempt_started', { attempt });
  try {
    const response = await fetch(input, init);
    diagnostic('api_attempt_headers', { attempt, httpStatus: response.status, requestId: response.headers.get('x-request-id'), durationMs: Date.now() - start });
    return response;
  } catch (error) {
    diagnostic('api_attempt_transport_error', { attempt, durationMs: Date.now() - start, errorType: error instanceof Error ? error.name : 'UnknownError', outcome: 'unknown' });
    throw error;
  }
};
