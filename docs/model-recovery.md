# AI diagnostics, stored responses and recovery

## Render configuration

Set `OPENAI_STORE_RESPONSES=true` in Render Environment and redeploy after the code is released. Omission defaults to false; only literal `true` and `false` are accepted. This affects future requests, not past ones. Retaining response content with OpenAI includes student/exam inputs and outputs and requires the client's agreement. Normal response retention is 30 days, subject to organisation data controls. Turning storage off does not delete previously stored responses. This setting does not alter grading prompts or allocations.

Keep `MODEL_TIMEOUT_MS=180000` initially. The SDK retains two retries: up to three attempts per create/retrieve operation, not a three-minute cap for the whole evaluation. No extra automatic application retry loop is added.

## Diagnostic events

Render receives structured JSON for runtime configuration, stage changes, logical task start/completion/failure, each SDK HTTP attempt, response headers/status and response reuse/retrieval. Filter by `runId`, then `questionIds` or `clientRequestId`. Attempt numbers come from the SDK retry-count header. A headers event is not proof that the response body was received or validated. HTTP errors, unknown transport outcomes and received-but-unusable outputs remain distinct. Logs use UTC timestamps.

Only allowlisted metadata is logged: IDs, stages, model, status, error class/code, timings and available usage. Headers, request/response bodies, passwords, API keys and raw exception messages are excluded. Client request IDs are correlation identifiers, not idempotency keys. A lost create response may leave no response ID to retrieve, even when OpenAI finished processing. API account usage can therefore exceed local known usage.

## Local recovery checkpoints

Each new submission saves atomic `task-<sha256>.json` sidecars alongside its saved PDF and evaluation. The key covers exact model, service tier, prompt, output schema and input content. Successful question responses survive another question's failure and process restart. Sidecars contain private response data, so protect and back up the same disk as submission history. They are not served by public routes. They share the archive lifetime of their submission; ordinary logs remain under Render's log retention. No second database or automatic cleanup/deletion of archived results is introduced.

The current report becomes failed when an unresolved request fails; the faculty recovery panel explains that successful responses are retained. Partial raw responses are not presented as final validated question marks. Known usage from saved responses is reconciled on failure; unreceived response usage remains unknown. Completed responses are validated and reused during explicit recovery without new inference calls. No response content is logged to stdout.

## Three scenarios and selected handling

1. **Completed response available:** replay the exact local response after validation, or retrieve by known response ID if local body is missing. No fresh generation is sent.
2. **Known response ID still processing / failed:** retrieve first. Pending responses are not duplicated; wait and retry recovery later. A terminal failed/cancelled/incomplete response can be replaced by a fresh call after faculty confirmation. Refusal/schema/mark-integrity errors are not silently retried by the recovery endpoint.
3. **No response ID after timeout:** retain the unknown outcome and client correlation ID. Do not claim the request was absent at OpenAI. Explicit faculty acknowledgement is required before another call, because duplicate processing/cost is possible.

Faculty report action: select **Retry unresolved work**, acknowledge the warning, and use **Refresh recovery progress** to view progress/completion. The endpoint is `POST /api/exams/:id/submissions/:runId/retry` with `{ "acknowledgeUnknownOutcome": true }`. It requires faculty access, a matching exam/run, failed state, an eligible transient/interrupted error and recovery checkpoints from the same application revision. It uses the original saved rubric/model, not the faculty's latest edits. The active-job guard prevents overlapping retries. Completed reports and historical failures without recovery support cannot be retried this way. No automatic recovery starts on server restart. Existing reports remain readable without migration.

## Verification and limitations

Tests use mocked API responses and include exact-input cache reuse, changed-input invalidation, unknown timeout, retrieval/pending handling, SDK attempts, log privacy, original-model retry, confirmation and frontend failure handling. Real OpenAI storage/dashboard visibility and live recovery require a controlled post-deployment test with an agreed test document. Background mode/webhooks are not enabled: they would require model compatibility and a separate job-lifecycle change. Current recovery is bounded, explicit request replay rather than a distributed exactly-once guarantee.
