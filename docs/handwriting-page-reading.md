# Batched handwriting reading

Runtime models now read answer sheets through the same two-stage page reader. Grading prompts, saved rubrics, model selection, optional-question arithmetic and overall rounding remain in place. Stored exams/reports require no migration.

## Reading and source preservation

The backend renders the original PDF into 2400-pixel PNG page images using Poppler. It reads two original pages per model request, with at most two batches in flight and one native rasterizer running at a time. The 50-page and 30 MB upload limits remain unchanged. Temporary images are private and removed after processing; the original uploaded PDF is retained.

The first model pass reads literal blocks, original page coverage, regions and uncertainty. It receives neither the question paper nor the answer key. The second pass structures those readings into answer entries using exact source quotes. The application checks quote existence, uniqueness, ordering, overlap and coverage before assembling answer text. It does not accept silently changed amounts or omitted substantive characters. Genuine bare unanswered labels stay in the literal record rather than becoming empty graded answers.

Original literal blocks are stored in `transcription.pageReadings`. A targeted crop may supply an evidenced reading change; the original text and `verifiedReadings` remain separately inspectable. Raw responses, including rejected outputs, remain private task checkpoints. Unsupported model-proposed identifiers become unnumbered content for evidence-based mapping; their original annotations remain in the raw structured response. No handwritten answer text is removed by that label guard.

Student identity is read only from original page 1, with literal name evidence required. Existing absent/unclear-name handling and manual-name entry remain unchanged. Administrative page readings and identity are excluded from grading requests.

## Quality and bounded recovery

Each requested page must have a keyed result. Missing, partial and unreadable pages, invalid regions, excessive page output, runaway MCQ enumeration and repeated content require recovery. Safety limits cause review/recovery, never silent truncation or a manufactured zero.

A failed reading batch keeps its valid sibling pages. For an invalid page, the reader allows one single-page retry and one full-page-plus-crops recovery. An otherwise complete page may receive one targeted visual verification call for up to two uncertain answer regions. If that optional close-up cannot resolve a word, its original reading and uncertainty survive for grading review. An unreadable word does not imply that the whole page was uninspected.

Structuring failures retain valid sibling results and allow one text-only recovery for the affected page. Persistent page/structure failures stop before mapping with `READING_QUALITY`. The existing faculty retry control supports this code with its cost acknowledgement. Known bad responses are not accepted merely because their JSON schema is valid. Transport failures do not trigger another application-level reading retry; the existing SDK transport policy remains separate.

Accepted literal and structured pages are checkpointed by document/model/tier/policy fingerprint. Matching accepted work is reused on retry. Failed model-task records and provider/client request IDs remain inspectable. A new explicit recovery can replace a known-invalid response while archiving the rejected one. Unknown request outcomes may still carry usage not available locally.

## Mapping and scoring compatibility

Question mapping remains a separate answer-sheet/question-text-only stage. Its output schema restricts question and candidate references to the supplied scored IDs. Historical blank or string-null references are conservatively treated as unresolved, without guessing a question. An additional ambiguous fragment does not erase numeric credit already supported by established answer sources; the review flag remains and the credited work contributes provisionally.

The application shows current page-reading/structuring/recovery progress and accepted page counts. It also exposes original literal page readings and visual reading evidence within the normal protected result view. It does not expose raw private task files.

## Deployment and local setup

The Docker runtime installs `poppler-utils`. No new Render environment variable or data migration is required when deploying through the existing Dockerfile. Preserve the persistent disk and normal backup procedure.

Local Windows development needs `pdftoppm` on PATH, or `PDFTOPPM_PATH` set to its absolute executable path in the backend `.env`, for example `C:/tools/poppler/Library/bin/pdftoppm.exe`. Other hosts using a non-Docker build must install Poppler explicitly. An unavailable renderer produces a clear backend error instead of reverting silently to whole-PDF transcription.

The renderer is a new native runtime dependency. Native rendering/cropping and the real 13-page sheet were exercised locally; the new image-rendering runtime has not yet been deployed or memory-benchmarked on the Render instance. Live speed and handwriting accuracy need representative measurements; no sub-minute or teacher-agreement guarantee is made.

## Verification

Automated coverage includes bounded concurrency, 50-page support, invalid page references, literal quote preservation, omitted amounts, original/crop evidence, non-material corrections, continuation mapping, blank name fallback, runaway output, selective recovery, unknown transport outcomes, checkpoint reuse, identity exclusion from grading, provisional marks, existing exams and frontend page progress.

See the local Financial Reporting test report for the real-sheet result and its limitations. The live test had a mapping encoding failure after successful reading; recorded responses were validated conservatively and reused for the grading continuation without another reading request. A teacher-marked reference was not available.
