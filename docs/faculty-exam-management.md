# Faculty exam management

Faculty exam rows offer **Edit title** and **Delete**, including for failed preparations. Both actions are disabled during preparation and rejected while the server's processing reservation is occupied. Hosted faculty authentication and same-origin write protection apply to the new routes.

## Edit title

`PATCH /api/exams/:id` accepts only `{ name }`, trimmed to 1–120 characters. Only the metadata title changes; exam ID, student link, preparation version, model, PDFs, rubric and submission history remain unchanged. The student page sees the new title when it next loads or refreshes its exam metadata.

## Delete confirmation and retention

The first dialog identifies the exam, submission count and effects. Faculty must continue to a second confirmation, type the exact current title and acknowledge that the student link will be disabled. Cancellation sends no delete request. The API requires the matching exam ID, current title and explicit acknowledgement, so a stale title cannot silently target a renamed exam.

`DELETE /api/exams/:id` atomically moves that exam directory to `exams/.deleted/<exam-id>` and removes it from the active catalog. Startup skips this private archive. Student metadata and new submissions return 404. Source PDFs, rubric and metadata remain available for administrator recovery; submission files and reports are not deleted or rewritten. Existing authorised report access remains intact. There is no public archive endpoint, automatic purge, disk reclamation or restore button. Restoring requires an administrator during a maintenance window, with the service stopped, moving the archived directory back to its original exam path and restarting. Never overwrite an existing directory during recovery.

The operation uses the existing global processing reservation to avoid deleting or renaming exam data during preparation or evaluation. Files are moved before the in-memory entry is removed, so a failed filesystem move leaves the exam active. This feature does not migrate or delete any existing data until faculty explicitly confirms a particular exam.

Tests cover persisted title edits, unchanged documents and rubric, exact confirmation, cancellation, busy rejection, faculty access, retained submissions, unaffected neighbouring exams and archive behaviour after restart.
