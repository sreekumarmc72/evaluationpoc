# Concise and concurrent Sol grading comparison

Measured on 12 October 2026. One run per strategy per sheet; this is a preliminary comparison, not a statistical accuracy or latency guarantee.

Both strategies used GPT-6.1 Sol, the same newly extracted GPT-6 Luna rubric, and the existing scan-checked calibration transcriptions. The transcriptions were previously checked by Codex against scans, not independently supplied by a human. Transcription, mapping, and PDF extraction latency are excluded. The concise prompt does not lower reasoning effort, alter scoring rules, or change rubric allocations. There is no controlled measurement against the previous verbose prompt, so its separate speed benefit has not been established.

| Reference | Concise sequential grading | Concise concurrent grading | Reduction | Question marks, both strategies | Teacher marks |
| --- | ---: | ---: | ---: | --- | --- |
| Full sheet | 34.32 s | 30.71 s | 10.5% | 6, 2, 2, 5, 10 = 25 | 6, 2, 2, 5, 10 = 25 |
| Partial sheet | 45.94 s | 37.79 s | 17.7% | 6, 2, 2, 3, 6.5 = 19.5 | 6, 2, 2, 1, 4 = 15 |

All four results had no pending questions. Concurrent grading preserved the sequential question-level scores in this comparison. The partial-sheet result is nevertheless 4.5 marks above its teacher reference: Q4 differs by +2 and Q5 by +2.5. Faster processing does not resolve these rubric/calibration differences. No score adjustment was added to force agreement.

| Reference | Sequential input / output / total tokens | Concurrent input / output / total tokens |
| --- | --- | --- |
| Full sheet | 13,068 / 2,376 / 15,444 | 25,716 / 2,634 / 28,350 |
| Partial sheet | 12,861 / 2,789 / 15,650 | 24,681 / 3,464 / 28,145 |

Concurrent requests used approximately 1.8 times as many total tokens because each question retains the full reading and mapping context. This ratio is not a billing-cost ratio: input and output prices and cache discounts differ. Concurrent execution is limited to three calls at a time. All requests in a batch drain on failure; the existing SDK retry limit and backend score/evidence validation remain intact.

The live application enables concise concurrent grading for Sol-only and mixed runs. Luna-only grading remains one call. Real PDF-to-result latency below one minute has not been demonstrated. Repeat the comparison on more teacher-marked sheets before claiming unchanged accuracy or an 85–90% teacher-agreement target.

Local reproducibility: `.tmp/grading-speed-manifest.json` and `.tmp/grading-speed-comparison/report.json`. These files contain student-derived data and are excluded from commits. Run `npm run baseline -- C:/Code/EvaluationPOC/.tmp/grading-speed-manifest.json C:/Code/EvaluationPOC/.tmp/grading-speed-comparison` to make a new paid comparison. The runner also records provisional marks and review flags for future runs.

Verification: 108 regression tests passed; TypeScript checks and production build passed. Tests cover concurrent execution, the three-call limit, result ordering, summed usage, rubric and uncertainty schemas, provisional marks, and draining requests before failure.
