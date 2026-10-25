# Blueprint-first exam preparation

New preparations use a version 2 scoring tree. Saved version 1 exams and reports continue through their existing validation and selection path; no migration or rewrite of prepared rubrics is required.

## Preparation

1. Read the question paper alone. Extract source-backed scored units, required combinations and equal-mark choices with unique IDs. Preserve shared scenarios and tables in the relevant scored text. Numbering that restarts in a new part is qualified by that part.
2. Validate the complete tree: printed exam maximum, arithmetic, source pages, quotas, unique ownership, no cycles, and bounded nesting.
3. Map every scored unit to the answer key, including every available alternative. Retain source pages and evidence. Missing or ambiguous key mappings remain blockers; the model must not solve a missing answer.
4. Generate rubrics in bounded batches, keeping descriptive parent subparts together. Preserve supplied allocations and label inferred allocations. Validate every rubric against its scored unit's maximum.
5. Save the final specification and fixed rubrics for student submissions.

Nodes are `score` (one independently marked unit), `all` (sum required children), or `choose` (select an explicit number of equal-maximum children). Two choice levels are supported along a path: whole-parent selection and an internal Either/Or alternative. Overlapping choices, unequal-maximum choices, ambiguous quotas, unsupported depth, contradictory totals and missing marks remain preparation blockers. MCQ answer options are never exam choices.

An existing keyed answer with a source discrepancy is preserved with a warning. For example, equivalent MCQ options do not justify inventing another accepted alternative or discarding the keyed answer. A teacher may need to review affected grading.

## Scoring

Handwriting transcription remains independent of the paper/key. It preserves visible subpart boundaries and original text. Resolution receives only the answer sheet, question identifiers/text and transcription, never expected answers or rubric content.

Grade scored units, combine internal choices and required subparts, then apply whole-parent selection. Never award both a parent and its children, or select subparts from different parents to fill an outer quota. Printed first-answer rules take precedence; otherwise excess answers use the approved highest-score fallback, with source order breaking ties.

Provisional question awards contribute to their parent, section and overall provisional total. Unresolved mapping/coverage can retain a review recommendation, but does not erase established awards. Teacher adjustments recalculate selection using saved attempt and script-order evidence. An adjustment does not turn an unattempted alternative into a student attempt. Existing overall display rounding is applied afterward.

## Persistence, progress and access

Each catalog entry retains `blueprint-draft.json` after structural validation, plus private `preparation-<sha256>.json` model-task checkpoints. These use atomic writes beside the existing exam documents. Retry reuses completed matching responses; changed documents/model/instructions/schema invalidate the relevant task fingerprint. Interrupted preparations remain failed and require the existing explicit retry.

Faculty sees preparation stages, can open the validated draft during/after failed preparation, and can inspect the final structure, key-page associations and rubrics. Student metadata contains selection instructions, not answer-key mappings. The draft endpoint is faculty-protected on the hosted service. Raw checkpoint files have no public serving route.

The existing persistent `DATA_DIR` must remain mounted. No new environment variable, database or disk migration is required. Keep the existing disk backup process before deployment.

## Financial Reporting reference

The supplied 18-page paper and 16-page key require a 100-mark exam: Part I has 23 compulsory MCQs totaling 30; Part II has compulsory question 1 for 14 and four of questions 2–6 for 56. Q2(b) has one internal 4-mark Either/Or choice. Q3(a)'s three requirements share eight marks; Q6(b)'s two requirements share four. These shared requirements stay in their single scored units.

Automated fixtures cover this structure, parent aggregation, internal alternatives, partial parents, first-answer precedence, provisional awards, teacher recalculation, invalid graphs, missing key mappings, source pages, private checkpoints, and restart compatibility. Live validation results are recorded separately; automated fixtures do not substitute for a real PDF preparation.
