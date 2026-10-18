# Durable student submissions

## Existing client exams

The existing `/data/exams` catalog, IDs, question/key PDFs, rubrics, model settings and student URLs keep their format. No migration or deletion of exams is performed by this feature. Before the first rollout, verify the Render disk is mounted at `/data`, `DATA_DIR=/data`, and confirm a disk snapshot covers the existing exams. Back up current metadata/rubrics and original PDFs off the service as well. A snapshot is a recovery aid, not a guarantee against every loss.

For this rollout, the seven live exam records copied on October 18, 2026 were loaded and compared unchanged with the new code. The Render snapshot shown by the operator was dated October 18 at 5:50 AM; all seven exam creation timestamps preceded it. The local JSON backup contains metadata and complete specifications/rubrics, **not** original PDFs. Later edits or new uploads require a newer backup. Nothing was restored or modified on the live disk during the compatibility check.

## Storage

New student submissions use `/data/submissions/<exam-id>/<submission-id>/`:

- `answerSheet.pdf`: original uploaded PDF, written before a model call starts.
- `evaluation.json`: exam/rubric snapshot, model, stage, transcript, name evidence, resolution, results, totals, warnings, usage and durations. Written atomically at stage checkpoints and on failure/completion. The complete JSON is the authoritative report; list summaries are derived from it to avoid inconsistent duplicate indexes.
- `access.json`: SHA-256 digest of a randomly generated browser-access token. It contains no plaintext token or faculty password.

The one-hour retention policy and DELETE/start-over operations **do not delete these saved submissions**. The original POC remains temporary. Source exams are not changed by submissions. Changing an exam's model later does not alter an archived run's model, rubric snapshot or marks.

The in-memory list of archived reports is rebuilt from JSON on startup. Completed reports and PDFs remain available. Incomplete runs become failed with `PROCESSING_INTERRUPTED`, preserving checkpoints and PDFs; there is no automatic retry or model charge. Damaged records remain untouched and are reported through the protected storage status. A failed disk write stops processing or prevents publishing a completed result, with a storage-specific error. No automatic archive deletion is implemented. Monitor available storage on the faculty screen, maintain backups, and expand the disk before it fills. This single-process JSON archive is intended for POC volumes; large histories will require a database/index and bounded report loading.

## Student name reading

The existing answer-sheet-only transcription request additionally reads a visibly labelled student-name field or a clearly attributable name near the top-right of page one. No extra model call is made. Identity includes `readable`, `unclear`, or `absent`, name/null, inspected page references and a note. Invalid/missing name evidence becomes unclear without blocking marking. Names are removed from the grading request's administrative identity field; the name is not a grading criterion. Names are not identity verification: every upload always gets a new UUID, and uploads are never merged by name.

## Faculty and student access

Before deploying, set these privately in Render → Environment:

```
FACULTY_USER=faculty
FACULTY_PASSWORD=<strong private password>
```

Hosted production requires faculty access even if the password has not yet been configured; faculty endpoints then fail closed with a configuration error. Local development can omit credentials or set them to test the gate. Over HTTPS, the browser prompts for faculty username/password when opening `/faculty`. Login credentials are kept out of application JavaScript, Git and saved reports. This is a shared POC access gate, not a multi-user account/permission system. Browser Basic-auth sessions are cached by the browser; use a separate profile/private window when sharing a device.

Faculty protection covers the page, exam listing/detail/mutation APIs, history, storage status and saved grade adjustments. Public student links and uploads remain available. Accepted uploads set an HttpOnly, SameSite=Strict cookie scoped to that submission's API path (Secure on hosted HTTPS), with a 30-day browser lifetime. It permits result/PDF access for that submission only. Refreshing the same exam page reconnects via its exam-scoped sessionStorage run ID. A server restart preserves that result. Losing the cookie/browser session requires faculty assistance; the durable faculty archive still retains the report. Student cookies cannot list history, access other students' records or change archived marks. Access tokens do not appear in URLs, JSON reports, or the faculty list.

Faculty endpoints:

- `GET /api/exams/:id/submissions?page=0&search=...`: newest-first summaries, 50 per page, name/UUID search, total count.
- `GET /api/evaluations/:submission-id`: full historical report.
- `GET /api/evaluations/:submission-id/answer-sheet`: original PDF.
- `GET /api/storage`: disk capacity, available bytes and unreadable-record warnings.

On the faculty screen choose **Submissions (N)** for an exam, then **View result**. The report reuses the existing question-level result and rubric presentation with PDF preview. Lists distinguish final marks, provisional scores, graded subtotals, unfinalised marks, failure and interruption. Archived reports are read-only in this UI.

## Backup and release check

1. Preserve a known-good disk snapshot. Do not click Restore as part of a normal deployment: restoring replaces newer data.
2. For an off-service full backup, use Render's authenticated SSH/SCP facilities to copy `/data` (or create an archive outside `/data`, then download it). Include exam PDFs, JSON specifications, submission PDFs/reports and access hashes. Keep backups private/encrypted and verify their contents. Never add them to Git.
3. Verify FACULTY variables and DATA_DIR in Render, then deploy the tested release. Do not redeploy while an evaluation is running; it would be marked interrupted after restart.
4. Sign in on `/faculty` and verify all existing exam IDs, rubrics and links remain available.
5. Submit one test sheet in a separate browser profile, inspect its saved report and then restart only after completion. Confirm the same report and PDF remain accessible to faculty and the submitting browser.
6. Verify an unauthenticated browser cannot list submissions or open a different student's report/PDF. Confirm a new submission does not remove an earlier report.

Past expired evaluations cannot be reconstructed from the old in-memory store. This feature archives new submissions after deployment; it does not claim to recover earlier results or preserve work that was still running when the old version restarted.
