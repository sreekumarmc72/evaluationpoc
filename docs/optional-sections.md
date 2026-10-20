# Optional answer-any-N sections

## Supported structure

Preparation accepts flat, non-overlapping groups of equal-mark whole questions with explicit answer counts, source instructions/pages and a printed exam maximum. Every available question needs its own answer-key entry and rubric. Group membership must match the extracted section evidence. Section allocations contribute `requiredCount × marksPerQuestion`, not the sum of all alternatives. Ungrouped questions remain compulsory. Ambiguous heading reconciliation continues to use the existing compulsory-only path.

The Cost Accounting paper has Part A questions 1–3, any two at 10 marks (20), and Part B questions 4–6, any two at 15 (30). It therefore has six available questions, four required answers and a 50-mark maximum, rather than 75. Public metadata exposes only selection instructions/counts, without the answer key.

Nested OR choices, overlapping groups, unequal-mark alternatives, selecting subparts, contradictory quotas and unsupported excess-answer instructions remain preparation blockers. A missing key for an optional alternative is still a blocker: it cannot be silently dropped or solved by the model.

## Selection and grading

Independent handwriting transcription preserves source order and explicit whole-answer cancellation evidence. Cancelled text remains inspectable in the raw transcription. Clearly withdrawn whole optional answers with evidence are excluded unless a material mapping/cancellation uncertainty remains; uncertainty about an old figure alone does not reactivate a cancelled answer. Crossed-out words or corrected lines do not withdraw an answer. Compulsory-paper answer handling is unchanged.

All available questions are assessed independently with their fixed rubrics. The backend then annotates each result as `counted`, `not_selected` or `pending_selection`; these annotations cannot be supplied by the grading model. Attempting an answer worth zero still counts as an attempt. Fewer than the required number of attempts receive only their assessed marks while the denominator remains fixed. Blank alternatives are labelled not selected, without a missing-answer deduction for each alternative; section notes explain missing required answer slots.

Excess answers cause selection review unless the paper explicitly instructs counting the first answers in script order. That supported policy uses the preserved answer order, never question-number order or highest marks. Without such an instruction, no best-N or first-N policy is inferred. Unresolved mappings block selection only where they could introduce another alternative or have material question-association/cancellation uncertainty. A continuation whose candidates are all already attempted can still require grading review without blocking selection. Unmapped supported fragments explicitly assessed as entirely non-material do not block selection; unsupported content and unexplained unknown-scope entries remain conservative blockers. Incomplete page coverage alone does not discard visible, established attempts: their awards contribute to the provisional section and overall totals, while the grading coverage warning remains. For example Q1=9 and Q3=7 contribute 16/20 provisionally. Genuine competing answers, unclear mappings and cancellation conflicts still block selection. Pending notes identify the affected entries or coverage problem instead of a generic warning. Unrelated sections retain their assessed subtotals.

For example, clearly mapped Q1=5 and Q3=7 count as 12/20 in Part A even with non-material crossed-out-word or presentation notes. Selection does not override genuine grading uncertainty. This change applies to new evaluations; saved reports and their stored selections are not silently rewritten, and no production submission is recalculated automatically.

Pending selection prevents a final total and prevents a fabricated provisional score for that section. Provisional marks remain available for counted answers with reading uncertainty. Teacher mark adjustments use the same stored counted selections and section maxima; adjusting an unused alternative does not make it counted. The existing teacher mark-review control does not resolve ambiguous/excess selections; these remain review cases rather than an automatic selection workflow.

## Persistence and presentation

Selection groups are optional additions to the shared exam contract; old prepared compulsory exams and reports load without migration. New reports retain per-question selection annotations and section results through the normal durable checkpoint. Catalog maxima, result maxima, history totals, percentages and teacher recalculations all use required section maxima. Existing final-total display rounding runs afterward; question awards and section calculations retain precision. Manual student-name entry, model choice and saved-exam reuse are unchanged.

Student upload pages show available/required counts and section instructions. Faculty details show the same rules beside the saved rubric. Student results and faculty reports share section subtotals, counted IDs, unused alternatives and selection-review explanations. The original POC also uses the same backend support.

## Verification and source finding

- Automated selection scenarios and HTTP lifecycle tests cover valid selections, under-attempting, zero-mark attempts, excess answers, explicit first-in-script policy, cancelled answers, uncertain scope, provisional scores, missing alternative keys, teacher adjustments, persistence/restart and frontend explanations. Existing compulsory-paper regressions remain in the full suite.
- Actual Accounting preparation succeeded with 6, 2, 2, 5 and 10 marks, total 25; actual Statistics preparation succeeded with 10, 10, 15 and 15, total 50. Both returned empty selection groups.
- Actual Cost Accounting extraction recognised both 2-of-3 groups and the correct 20 + 30 structure, but preparation correctly stopped: the local `Cost_Accounting_Answer_Key_2026.pdf` has five entries and no solution for the paper's question 3 (inventory turnover ratios and comments). Its later questions are numbered 3–5 whereas the paper uses 4–6. The engine did not invent that missing answer or drop the choice.
- Real end-to-end AI grading for Cost Accounting still needs a corrected matching key and a student answer sheet. Model extraction remains probabilistic; section arithmetic and membership are verified by backend code, while source interpretation remains model-extracted evidence.

The extraction prompt is part of the cache fingerprint, so retrying a failed preparation uses the new policy. Existing ready exams are not regenerated. No new model call, retry loop, database or data migration was added to the normal pipeline.
