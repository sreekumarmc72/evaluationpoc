# Real handwriting validation checklist

The app and automated tests can be validated without a key. Real transcription quality cannot.

1. Choose one English exam with text answers and maths, all questions mandatory. Include explicit maximum marks and a complete key. Prefer a supplied partial-credit rubric.
2. Prepare five anonymized student scans: clear/correct; equivalent/partial; correct and incorrect mathematical working; page continuations with missing answers; poor/ambiguous handwriting.
3. Have a human transcribe every answer, including mistakes and uncertainty. Use the same canonical question IDs and LaTeX conventions. Include skipped questions as an empty reference text with zero marks. Use `marks: null` where a human also needs review.
4. Have a human grade independently using the key. Record every leaf question's marks. Do not edit these references to match model output.
5. Run the smoke test on one sheet and visually compare its transcript before running the full baseline.
6. Run the baseline manifest and inspect `report.json`. Separately note lost words, wrong symbols, incorrect question mapping, missed uncertainty, unjustified credit and inconsistent rubric use.
7. Re-run a small subset to measure variability. Decide tolerable transcription and marking differences from the observed data before calling the POC reliable.

The manifest is a template, not a completed validation dataset. No accuracy result is claimed by this repository.
