# Manual student names

Completed durable submissions whose scanned name is absent or unclear prompt the owning student session for a name. The popup offers **Save name** and **Skip for now**; Escape also skips. Skipping is remembered for that submission in the browser session and leaves an **Add student name** button beside the result. A saved name prevents further prompting. Readable scan names, active/failed runs and temporary original-POC runs are unaffected.

Faculty can enter a missing name inside an opened submission report. The manual name is used for history display, search and report headings, labelled **Manually entered**. Original scan identity, page references and uncertainty notes remain visible and unchanged. Names are not sent to any model, do not identify or merge students across submissions and do not affect marks.

`PATCH /api/evaluations/:id/student-name` accepts only `{ name }`, trimmed and limited to 1–160 characters. The endpoint requires the saved submission's owning cookie or faculty authentication. The student-specific exception applies only to this exact PATCH path; grading adjustments remain faculty-only. Only completed saved submissions with no readable scan name accept manual entry. Existing manual names can be corrected through this authenticated endpoint; the UI does not offer editing readable scan names.

An atomic `student-name.json` file beside each saved PDF/report stores the manual name and timestamp. The original evaluation file is not rewritten when a name is saved. Startup loads this optional file without migrating old submissions. Unreadable name files are preserved and reported as a warning while the evaluation and marks remain available. Faculty score adjustments preserve the latest in-memory manual name; the separate name file remains authoritative across restarts.

Tests cover absent/unclear names, saving, skipping, readable and previously saved names, save errors, input validation, cookie isolation, faculty access, history search, restart persistence and unchanged grading bytes/PDFs.
