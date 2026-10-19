# Section marks reconciliation

Exam preparation preserves printed exam totals, section headings, source pages and explicit question allocations in `marksEvidence`. An unqualified section heading such as “Section A – 10 Marks” is ambiguous; it is not automatically a section total.

The backend accepts a per-question interpretation of such a heading only when every scored question has an explicit allocation, all questions are covered once by the evidence, their allocations match the scoring specification, the sum matches an explicitly printed exam maximum, and every question in the affected section matches its heading's mark value. This ambiguity-reconciliation path remains limited to compulsory papers. Explicit optional “answer any N” instructions use the separate selection-group validator and required section maxima. Explicit section totals and explicit “each” headings must match their respective arithmetic. Genuine conflicts, missing evidence and unrelated preparation issues remain blockers. No marks are rescaled or inferred to repair a total.

The interpretation is recorded in exam warnings, already visible through prepared exam details and evaluation reports. No extra model call is added. Section-local numbering becomes stable identifiers such as `A-1` and `B-1`; ambiguous bare student labels go through existing answer resolution rather than being assigned by number alone.

Existing stored exams without this optional evidence field remain compatible and are not rewritten. The extraction prompt is part of the preparation cache fingerprint, so a retry uses the new policy while already prepared exams retain their saved rubric.

## Verification

- Real Business Statistics PDFs: preparation succeeded with A-1=10, A-2=10, B-1=15 and B-2=15, total 50. Source headings remain marked ambiguous and interpretation warnings are retained.
- Real accounting PDFs: a diagnostic preparation succeeded with question maxima 6, 2, 2, 5 and 10, total 25, preserving the approved accounting policy. An earlier run was rejected because the generated Q5 rubric did not sum to its maximum; no arithmetic guard was relaxed and no automatic retry was added. This is a remaining model-output variability risk, separate from section-heading reconciliation.
- Automated coverage includes the 25-mark unsectioned accounting structure, legacy records, explicit conflicting section totals, inconsistent or absent exam totals, missing individual marks, invalid or duplicated question references, unrelated issues, and optional selection.
- These checks verify preparation and arithmetic, not end-to-end grading accuracy on future student sheets. Model extraction remains probabilistic; evidence is model-extracted, not an independent OCR verification.
