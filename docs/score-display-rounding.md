# Overall score display rounding

Student results, original POC results, faculty submission history and opened reports use the same presentation helper. A total's fractional part below 0.5 rounds down to an integer, above 0.5 rounds up, and exactly 0.5 remains a half mark. Examples: 24.75 becomes 25; 21.25 becomes 21; 21.5 stays 21.5. Display scores are capped at the unchanged maximum marks, including exams with fractional maxima.

Only the overall final total, provisional total and graded subtotal are rounded. Question marks, teacher adjustments, criterion awards, maximum marks and saved calculations are unchanged. Final displayed percentages are recalculated from the displayed total. The shared helper also computes a matching provisional percentage, but pending results continue to withhold a final percentage and retain their review labels.

Detailed reports include an expandable **Total calculation & rounding** section showing the original calculated total. A fully pending result without a proposed total continues to show **No marks finalised**. A positive assessed subtotal that rounds down to zero is shown as a zero subtotal, rather than being mistaken for an entirely unassessed submission.

Existing history adopts the presentation rule when loaded; no data migration, rewriting, new model calls or change to grading instructions is required. API totals remain exact. Tests cover boundaries, half marks, score limits, percentages, provisional and unavailable totals, exact question marks, history display and non-mutation of saved objects.
