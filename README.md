# Simple Handwritten Answer Sheet Evaluation — POC

## Faculty and Student pages

New student submissions are now archived durably under their exam, including the original PDF, result, rubric snapshot, model and readable student-name evidence. Faculty can open **Submissions (N)** to inspect reports. Hosted faculty access now requires `FACULTY_USER` and `FACULTY_PASSWORD`; student access uses a submission-scoped HttpOnly cookie. See [saved submission history and rollout instructions](docs/submission-history.md) before deployment. Existing exams and links keep their format.

The faculty workspace keeps a compact creation form beside a searchable exam table. On desktop, the exam list scrolls within its panel; smaller screens stack the panels. Rubric details open in a keyboard-accessible modal, and ready exams have copy-link and new-tab student-link icons. Student pages show branding without header navigation. These presentation changes do not change saved exams, model selection, grading or storage.

The original POC at `http://127.0.0.1:5173/` retains its existing workflow. Two separate pages are now available:

- **Faculty:** `http://127.0.0.1:5173/faculty` — name an exam, upload the question paper and key, and create it. Preparation validates the PDFs, extracts questions/answers and creates the rubric. The page polls preparation status and allows inspection of the saved questions, marking guidance and criterion allocations. Failed preparations can be retried explicitly. Create another exam to change documents or marking rules; ready exam documents and rubrics remain fixed. In the exam details popup, faculty can edit the evaluation model without recreating the exam or changing its student link.
- **Student:** `http://127.0.0.1:5173/student/<exam-id>` — open the link shared by faculty and upload one answer sheet. There is no exam dropdown or student model selector. The bare `/student` page asks for a faculty-provided link. The student route loads the fixed specification directly and **never calls exam extraction**, even after restart. It transcribes the sheet, resolves reading/mapping only when needed, and grades against the saved rubric. Results show marks, deductions, rubric awards, review flags and the PDF preview. Teacher adjustment controls are not shown on this page. The student run ID uses a browser session-storage key scoped to its exam ID, so refreshing reconnects without resubmitting.

Faculty exam creation defaults to GPT-6.1 Sol; Ultrafast is an optional higher-cost tier. The latest saved faculty choice is enforced for new student evaluations of that exam, including submissions from a student page opened before the edit. Model edits are persisted to disk; the original rubric preparation model is retained separately when the evaluation model changes. Saving makes no model call and does not regenerate the rubric. Model edits return a busy error while preparation/evaluation is active; retry saving after it finishes. Student requests cannot override the model. The saved rubric is reused unchanged. Hosted faculty records use a shared access gate; public student exam links remain accessible. This is not a multi-user authentication system.

Exams live in `.local-data/exams/<generated-exam-id>/`, containing `metadata.json`, `questionPaper.pdf`, `answerKey.pdf`, and `specification.json`. The directory is excluded from Git. JSON updates use atomic replacement. Multiple exams and their validated specifications are loaded into memory on startup and survive backend restarts. A preparation interrupted by restart becomes failed and requires explicit retry; no model calls restart automatically. Original document hashes and specification version are recorded. New student answer-sheet runs are retained durably; only the original POC keeps its one-hour temporary lifecycle. Neither starting a new submission nor clearing the original POC's retained exam removes faculty-created exams.

New endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/exams` | Multipart `name`, optional `model`, `questionPaper`, `answerKey`; return `202` and exam ID |
| `GET /api/exams` | List exam metadata and readiness |
| `GET /api/exams/:id` | Metadata and prepared specification |
| `POST /api/exams/:id/prepare` | Retry a failed preparation |
| `PATCH /api/exams/:id/model` | JSON `{ model }`; update a ready exam’s evaluation model without changing its rubric or link |
| `GET /api/exams/:id/student` | Exam metadata only, without expected answers or the rubric |
| `POST /api/exams/:id/evaluations` | Multipart `answerSheet` only; use the saved faculty model; return `202` and run ID |

Student evaluations use the existing polling and answer-sheet-preview endpoints. Every student run records `examId`, `examVersion`, and `examReused`; its durations contain no extraction stage and its usage excludes faculty preparation. The single active operation limit is shared by exam preparation, the original POC, and student evaluations. Prepared exams are selectable only after their complete rubric passes validation. No database, job broker or cloud storage is introduced.

For the demo: prepare an exam on the Faculty page, wait for **Ready**, inspect the rubric, then use **Open student page** or **Copy student link** on that ready exam. Invalid/unavailable links cannot accept submissions; preparing exams display a waiting message. Opening another exam cannot restore a previous exam's results. Subsequent sheets reuse the same prepared exam. Preparation duration is shown separately on the faculty exam card; student-stage durations and tokens appear in results. This removes preparation work from student latency, but actual end-to-end speed still depends on transcription, conditional resolution and grading. No fixed latency or teacher-agreement guarantee is made.

Regression coverage includes multiple named exams, restart persistence, interrupted/failed preparation and explicit retry, shared busy limits, invalid uploads, immutable prepared specifications, zero student extraction calls, answer-sheet-only storage, read-only student results, and reconnecting without another submission.

React + Node.js application for **question paper PDF + answer key PDF + one handwritten answer-sheet PDF → transcription → evaluation → marks**.

## Run locally

Requires Node.js 20.11+ and npm. From the project root:

The project enables `legacy-peer-deps` in `.npmrc` to avoid npm 10.2's resolver crash in Vitest's optional devtools graph. All peers needed for the app and tests are declared explicitly. Dependencies are locked in `package-lock.json`.

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` to set `OPENAI_API_KEY` and the **exact** `OPENAI_MODEL` ID you already tested. For example, use `gpt-6-sol` only if that is your accessible model. No model fallback is configured. Keep the key out of frontend variables and source control.

```powershell
npm run dev
```

Open http://127.0.0.1:5173. The API binds to http://127.0.0.1:3001. If you change `PORT`, update the proxy target in `apps/web/vite.config.ts` as well. Restart the backend and reload the page after changing model configuration.

```powershell
npm run typecheck
npm test
npm run build
```

`npm start` starts only the backend; `npm run dev` is the intended local full-stack entrypoint. The frontend production build is created in `apps/web/dist`; cloud deployment and production hosting are outside this POC.

## First: prove handwriting input

Before relying on marking, test a representative **real scanned handwritten** PDF:

```powershell
npm run smoke -- "C:/path/to/answer-sheet.pdf"
```

This makes one billable transcription call with the configured model, high-detail PDF vision, Structured Outputs, and `store: false`. It prints the transcription intentionally for manual inspection. Compare ordinary text, mathematical symbols, question IDs and answers continued across pages. A successful schema response proves API compatibility, not handwriting accuracy.

Real scans and API credentials are not included. Anonymised scan-checked transcription references and teacher grades for the two-sheet calibration are in `docs/calibration-references.json`. Automated tests use generated PDFs and mocked model outputs; real-model evidence is reported separately.

## Supported input and marking

- Exactly three valid, unencrypted PDFs; default maximum 10 MB and 10 pages each. These can be scanned PDFs without a text layer.
- English short/descriptive answers and mathematical working. Use clear printed question numbers, preferably `1`, `2(a)`, `2(b)`. Every scored leaf question needs marks in the paper and an answer in the key.
- Compulsory questions and flat, disjoint equal-mark “answer any N” sections are supported. Optional section maxima use the required quota rather than all available alternatives. Excess answers require review unless the paper explicitly says to count the first answers in script order. Nested OR choices, unequal-mark or overlapping options, unsupported selection policies and diagram grading remain unsupported. See [optional section rules](docs/optional-sections.md).
- Missing keys, missing marks, conflicts or ambiguous exam structure stop evaluation. The model is instructed to report these; automated extraction is not guaranteed to discover every conflict.
- Equivalent wording can earn partial credit. Supplied rubrics take precedence; keys without detailed rubrics use explicitly labelled inferred holistic grading.
- Handwriting transcription sees **only** the answer sheet. A conditional resolution call sees that scan, question texts and raw transcription, with no key, marks or calibration examples. Grading sees the extracted exam, mapped transcription and auditable verified readings.
- Equations use `$...$` / `$$...$$` LaTeX, rendered with KaTeX. No separate OCR service, PDF rasterizer, or equation solver is used.
- Structured reading uncertainties require question-level scoring-impact decisions. Non-material notes and unreadable abandoned drafts do not block clear final work. Ambiguous mappings block candidate questions; candidate-free unmatched content prevents marking an absent question unattempted, while existing reliable answers can be graded. Incomplete page coverage still withholds final marks conservatively. Diagrams remain unsupported.
- The grading model's schema has required fields for each question and each uncertainty ID. The SDK adapter converts those keyed objects to public result arrays. Reading notes cannot be silently omitted for a difficult answer. Credit can be established by other clear final work written by the student, while the ambiguous digit stays unchanged.
- An absent answer gets zero only for complete, unambiguously mapped transcription. The backend rejects invalid question IDs and impossible marks and calculates totals itself.
- Pending questions produce a subtotal without a final total or percentage. If all questions are pending, the UI shows “No marks finalised.” Raw transcription, mapping evidence, verified re-readings and informational notes remain inspectable and read-only.

## Architecture

```text
apps/web             React upload, polling, results, KaTeX, local PDF preview
apps/api             Express routes, PDF checks, temporary run store
  src/prompts.ts     Separate extraction, transcription, resolution, grading instructions
  src/model.ts       OpenAI SDK adapter and structured schemas
  src/pipeline.ts    Sequential processing and safe stage errors
  src/evaluation.ts  Shared HTTP and baseline orchestration
  src/validation.ts  Exam/transcription validation and scoring guards
packages/shared      Zod schemas and TypeScript contracts
```

The API key never leaves the backend. PDF inputs are base64 inline inputs to the Responses API, with `detail: high` and `store: false`. There are no persistent OpenAI file uploads or conversation chains. This setting does not itself guarantee zero provider retention; consult your account's data controls.

One run can be active at a time, including upload validation. The browser polls every two seconds. The server keeps run metadata in memory and run PDFs in a process-owned temporary directory with UUID filenames. The currently selected exam PDFs and validated extraction cache are retained separately in `.local-exam/`. No authentication, database, Redis, history, bulk uploads, or cloud infrastructure.

Completed and failed runs expire after one hour (cleanup scans every 30 seconds). Start over deletes their files immediately. Restarting loses all run metadata. Graceful shutdown deletes this process's files; a forced process kill can leave an orphan temporary directory under the OS temp folder. Keep the app bound to localhost.

Model timeout defaults to 180 seconds **per attempt**; SDK transient retries are limited to two. A stage can therefore take longer than three minutes. No application retry layer is added. Terminal failure exposes a safe error and the failed stage while retaining any prior extraction/transcription for inspection. Logs include run ID, stage duration, model and token usage; no uploaded text or secrets are logged.

## API

| Method | Endpoint | Result |
|---|---|---|
| GET | `/api/health` | Configured state, model, upload limits, retention |
| POST | `/api/evaluations` | Multipart `questionPaper`, `answerKey`, `answerSheet`; `202 { id }` |
| GET | `/api/evaluations/:id` | Stage, available data, errors, usage, timings |
| DELETE | `/api/evaluations/:id` | Delete terminal run; `204` |
| GET | `/api/evaluations/:id/answer-sheet` | Original PDF while run exists |

Stages: `validating → extracting_exam → transcribing → resolving_answers (conditional) → evaluating → completed`, or `failed`. Runs expose raw `transcription`, separate `resolution` mappings/readings, and `resolvedTranscription`. Upload validation happens before `202`. Restart and upload again after schema changes; runs are in-memory, so no data migration is needed. Busy and active-delete requests return `409`; unknown/expired runs return `404` with re-upload guidance.

## Real-model baseline

Prepare at least five actual handwritten scans and human references using the template in `samples/manifest.example.json`. File paths are relative to the manifest. Replace placeholders before running:

```powershell
npm run baseline -- "C:/samples/manifest.json"
```

This makes billable model calls and writes `baseline-output/report.json` with transcription, mapping evidence, review flags, per-question mark differences, total differences and diagnostic character error rates. End-to-end runs use the same pipeline as the application, including exam extraction. Reports contain student content; keep raw reports local. Character error rate includes LaTeX formatting differences and is not a calibrated handwriting metric.

Cases: clear/correct; equivalent/partial; maths with correct and incorrect steps; answers across pages with skipped questions; poor scans with ambiguous or illegible content. Do not substitute printed synthetic documents for real handwriting validation. Inspect errors in transcription separately from grading errors and agree accuracy targets after measuring the baseline.

See [samples/BASELINE.md](samples/BASELINE.md) for the human validation checklist.

## Teacher calibration for this accounting test

The default UI selection is now **Luna reading + Sol grading** (`model=luna-sol`): Luna handles exam/rubric extraction, handwriting transcription and conditional resolution; GPT-6.1 Sol handles evaluation. Both single-model options remain available. Processing details show the actual model for each stage. Mixed mode shares Luna's rubric cache with Luna-only runs; Sol grades the fixed Luna-generated rubric rather than regenerating it. Existing clients that omit `model` still use `OPENAI_MODEL`. Mixed-mode speed and teacher agreement need real-sheet validation; it does not guarantee a one-minute evaluation.

Sol grading now uses concise evidence and deduction statements and grades at most three questions concurrently. Each request receives the full transcription and resolved mappings but only its target question and fixed rubric. This preserves continuation and unmatched-content context. The backend merges results in exam order, sums token usage, and applies the same scoring validation. All in-flight requests finish before a failed run releases its slot; no additional retry loop is introduced. Luna-only grading remains one request. Concurrent Sol calls repeat some input context and may cost more or hit rate limits sooner. Reasoning effort, rubric allocations and grading rules are unchanged.

To isolate the speed/quality comparison, add `"gradingComparisonOnly": true` to a local calibration manifest containing checked `referenceTranscription` entries, then run `npm run baseline -- <absolute-manifest-path> <absolute-output-directory>`. The runner extracts one fixed Luna rubric and compares concise sequential versus concurrent Sol grading on each checked answer, recording duration, usage, per-question differences, provisional scores and review flags. This measures grading only, not full PDF-to-result latency. It makes paid API calls; raw reports contain student-derived evidence and should stay local.

The upload form offers the mixed profile plus **GPT-6.1 Sol**, **GPT-6 Luna**, and **GPT-6.1 Sol · all stages · Ultrafast**. The Ultrafast profile (`model=sol-ultrafast`) sends the actual model `gpt-6.1-sol` with `service_tier: "ultrafast"` on every model call. It keeps the same prompts, scoring validation, concurrent grading, timeouts and SDK retry limit, and shares the standard Sol exam/rubric cache. It is an explicit higher-cost choice; the existing default stays unchanged. Processing details distinguish the requested Ultrafast profile from the actual Sol stage model. Real-sheet Ultrafast latency has not been benchmarked and a one-minute result is not guaranteed. See [official Ultrafast documentation](https://developers.openai.com/api/docs/guides/ultrafast-mode).

Optional multipart field `model` selects an allowlisted model or routing profile; omitting it preserves the configured API default for existing clients. Results, timings and token usage identify the selected profile and stage models. Rubric caches belong to the model performing extraction. Account access is checked by the actual request; no silent fallback occurs if access or the requested tier is denied. Luna speed and handwriting quality have not yet been benchmarked on the reference set.

For lower latency, exam/rubric extraction and independent handwriting transcription run concurrently (`reading_documents`). Transcription still receives only the student PDF. The pipeline waits for both results before resolution/grading and drains both calls before releasing the active slot on failure. Per-call durations and the overlapping reading-phase wall time are recorded separately; do not add the overlapping durations to estimate total elapsed time. Rubric reuse and conditional resolution remain enabled, and grading explanations are kept concise. The model, timeout and SDK retry settings are unchanged. Both reading calls may incur usage even if one fails; restarting or resubmitting is not a connection recovery strategy.

Exam extraction now also creates an answer-key-aligned rubric before transcription. Supplied mark splits and approved conventions take precedence; missing allocations are labelled **AI-inferred—not teacher-approved**. Each criterion records its maximum, expected evidence and key basis. The backend checks that allocations sum to the question maximum, validates every criterion award and source-entry reference, and calculates question marks from the awards. Expand **Marking rubric & how it was applied** beside each question to see allocations, evidence, deductions and source pages. Manual adjustments remain separate from the original rubric assessment.

The selected question paper and answer key are retained in `.local-exam/` until explicitly replaced or cleared. They survive page refreshes and backend restarts. The first submission still requires all three PDFs. Afterwards, use **Start over** and choose only a new answer sheet. The saved filenames remain visible; choosing a replacement for either exam PDF updates that document on the next accepted upload. **Clear saved exam** removes both retained PDFs and persistent rubric caches. Invalid replacement PDFs leave the saved exam unchanged. Answer sheets and results retain their existing temporary lifecycle.

Validated extraction results are also saved locally (up to 20 cache entries), keyed by separate content hashes of both PDFs, the actual extraction model and extraction instructions. Matching submissions skip the question-paper/answer-key model call and reuse the fixed exam specification and rubric, including after restart. Changed bytes or a different extraction model require fresh extraction; standard and Ultrafast Sol share the same cache because their model and instructions match. Cache reuse is reported explicitly in the results and consumes no extraction tokens. Handwriting transcription, conditional answer mapping and grading still run for every new sheet. The cache removes extraction work but does not guarantee total processing below one minute. Historical calibration results predate criterion-based marking and do not establish accuracy for this new version.

`POST /api/evaluations` now accepts `answerSheet` alone when a retained exam exists, or optional replacement `questionPaper` / `answerKey` fields along with it. The response and `GET /api/health` expose retained filenames, sizes and page counts. `DELETE /api/exam` deliberately clears the saved exam and rejects changes while a run is active. `.local-exam/` is excluded from Git and contains the retained PDF data and exam specifications; no database or cloud storage is added.

Questions requiring review can carry evidence-based provisional marks, shown separately from final AI grades. A provisional total includes those tentative awards and is clearly labelled; it is not a final total. If no defensible proposal exists, the question remains unscored. Expand **Review or adjust marks** under any completed question, enter marks and a reason, and save. The backend validates the range and recalculates totals; the original AI score, explanation and review flags remain visible. Original POC adjustments expire with the evaluation; archived student-report adjustments require faculty credentials and are saved durably. Reviewing makes no model call. The `PATCH /api/evaluations/:id/questions/:questionId` endpoint accepts `{ marks, reason }`.

Use `output/answer-key/Accounting Test Solutions Teacher Aligned v1.pdf` as the uploaded key. Its printed policy identifier is `accounting-teacher-v1`; the same policy source is `docs/marking-policy-v1.json`. The application applies policies extracted from the uploaded key, never from filenames or student identities. The teacher's Q4 convention does not independently resolve the paper's opening-stock discrepancy.

The local study manifest is `.tmp/calibration-manifest.json`. It contains paths to the two user-supplied scans, three repetitions per sheet, checked transcriptions for isolated grading, and expected marks. It can be recreated by combining `docs/calibration-references.json` with your local PDF paths, `mode: "calibration"`, `repetitions: 3`, and `isolatedGrading: true`.

```powershell
npm run baseline -- C:/Code/EvaluationPOC/.tmp/calibration-manifest.json C:/Code/EvaluationPOC/output/calibration-v1
```

The runner first grades the checked transcription for each case, then runs each PDF three times. It writes checkpoints after every result. Expected totals are 25 and 15, with question marks `[6,2,2,5,10]` and `[6,2,2,1,4]`. These are calibration targets, not a general accuracy guarantee. No score adjustment is applied to force agreement. Broad baseline mode still requires five sheets.

After the runner completes, use `node tools/summarize-calibration.mjs` to create [the comparison report](output/calibration-v1/Results.md). Raw JSON reports contain student content and remain local. Earlier exploratory reports are retained separately so reading and grading failures remain inspectable.

To rebuild the versioned key, run `tools/build-teacher-key.py` with the bundled Python runtime. PDF pages have been visually checked; DOCX pagination requires Word or LibreOffice and is not verified by the PDF builder.

## Official API references

For connection diagnosis, run `npm run connectivity`. It checks the backend, the web proxy and configured OpenAI model access using a metadata request, without generating an answer or uploading PDFs. Successful metadata access does not prove a long PDF request will complete. The browser retains the run ID in session storage and reconnects to that run after a refresh; reconnecting does not resubmit model calls. Server restarts clear original POC runs; saved student submissions reconnect from their durable archive.

- [PDF input](https://developers.openai.com/api/docs/guides/file-inputs)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-6 Sol model](https://developers.openai.com/api/docs/models/gpt-6-sol)
## Hosting

For a free-first Render deployment and later persistent-disk upgrade, see [the Render deployment checklist](docs/render-deployment.md). The root `render.yaml` provisions one free Docker web service, with no paid storage. Free-hosted saved exams are temporary until a persistent disk is attached.

See [the Railway deployment checklist](docs/railway-deployment.md) for signup, repository access, public URLs, environment variables, persistent storage, free-trial limitations and launch verification. The Dockerfile builds React and runs it with Express as one service; `railway.json` configures its deployment health check.

