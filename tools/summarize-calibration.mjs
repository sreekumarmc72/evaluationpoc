import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const folder = path.resolve(process.argv[2] ?? 'output/calibration-v1');
const report = JSON.parse(await readFile(path.join(folder, 'report.json'), 'utf8'));
const rows = report.reports;
const scored = rows.filter(r => !r.error);
const complete = scored.filter(r => r.observedTotal !== null);
const exact = complete.filter(r => r.comparisons.every(c => c.markDifference === 0));
const lines = [
  '# Teacher aligned accounting calibration results', '',
  `Model: **${report.model}**. Marking policy: **${report.policyVersion}**. Pipeline: **${report.pipelineVersion ?? 'exploratory'}**.`, '',
  'The teacher supplied reference marks of [6, 2, 2, 5, 10] and [6, 2, 2, 1, 4]. Reference transcription was checked by Codex against scan images; it was not independently supplied by a human. The full-sheet machinery label and continuation were manually associated for the isolated grading reference. Student mistakes and June date labels were retained.', '',
  '## Per-question comparison', '',
  '| Sheet | Phase | Attempt | Q1 | Q2 | Q3 | Q4 | Q5 | Total | Difference |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
];
const n = value => value === null || value === undefined ? 'Pending' : String(value);
for (const r of rows) {
  const scores = r.comparisons?.map(c => n(c.observedMarks)) ?? ['—', '—', '—', '—', '—'];
  lines.push(`| ${r.name} | ${r.phase} | ${r.attempt ?? '—'} | ${scores.join(' | ')} | ${r.error ? 'Failed' : n(r.observedTotal)} | ${r.error ? '—' : n(r.totalDifference)} |`);
}
lines.push('', `${exact.length}/${rows.length} recorded trials matched every teacher question mark; ${complete.length} had complete totals. ${rows.filter(r => r.error).length} failed; ${scored.filter(r => r.observedTotal === null).length} completed with pending marks.`, '', '## Reading and mapping observations', '');
for (const r of rows.filter(r => r.phase === 'end_to_end')) {
  lines.push(`### ${r.name} attempt ${r.attempt}`, '');
  if (r.error) { lines.push(`Failed during ${r.failedStage}: ${r.error}`, ''); continue; }
  const e = r.evaluation;
  const changed = e.resolution.mappings.filter(m => e.transcription.answers.find(a => a.entryId === m.entryId)?.identifier !== m.questionId);
  if (changed.length) for (const m of changed) lines.push(`- ${m.entryId} → ${m.questionId ?? 'unresolved'}: ${m.evidence.replaceAll('\n', ' ')}`);
  else lines.push('- No inferred label or continuation changes were required.');
  for (const reading of e.resolution.readings) lines.push(`- Verified reading on pages ${reading.sourcePages.join(', ')}: ${JSON.stringify(reading.originalText)} → ${JSON.stringify(reading.revisedText)}. ${reading.evidence.replaceAll('\n', ' ')}`);
  for (const result of e.results) {
    for (const flag of result.reviewFlags) lines.push(`- Q${result.identifier} review: ${flag}`);
    for (const note of result.notes) lines.push(`- Q${result.identifier} note: ${note.replaceAll('\n', ' ')}`);
    if (r.name === 'reference-partial' && ['4', '5'].includes(result.identifier)) lines.push(`- Q${result.identifier} grading: ${result.justification.replaceAll('\n', ' ')}`);
  }
  lines.push(`- Diagnostic text differences by question (character edit rate): ${r.comparisons.map(c => `Q${c.identifier} ${(c.characterErrorRate * 100).toFixed(1)}%`).join('; ')}. Formatting, labels and LaTeX affect this measure; it is not a calibrated handwriting accuracy score.`, '');
}
lines.push('## Interpretation and limits', '',
  exact.length === rows.length ? 'Every recorded trial met the question-level calibration targets.' : 'The repeated-run acceptance target is not fully met. Differences and pending questions above remain unresolved; the application does not substitute teacher reference scores for its model output.', '',
  'This is calibration on two known sheets, with teacher examples present in the supplied key. Agreement demonstrates the intended policy on these examples, not generalisation to unseen students. No score adjustment or filename-based grading was applied. Initial exploratory failures are retained in output/calibration-v1-exploratory/report.json; they exposed uncertainty-page annotation handling and validation against already-corrected text. A second study, retained in output/calibration-v1-before-required-decisions/report.json, scored the full sheet 25 three times but withheld the partial sheet’s Q5. One response omitted its uncertainty assessments, while others considered isolated digits score-changing despite clear method evidence elsewhere. The final pipeline uses required keyed assessment fields and explicitly considers corroborating final work and holistic credit, without repairing source digits.', '',
  'A broader independent baseline still needs at least five sheets, human transcription references and teacher grading. Q4 uses the explicitly teacher-approved exam convention; the paper’s separate opening-stock entry remains a source discrepancy. Diagram grading is unsupported. The DOCX key is editable but Word pagination remains unverified because LibreOffice is unavailable.', '',
  `Answer-key SHA-256: ${report.answerKeySha256}`, '',
);
await writeFile(path.join(folder, 'Results.md'), lines.join('\n'));
console.log(JSON.stringify({ trials: rows.length, exact: exact.length, completedTotals: complete.length, failed: rows.filter(r => r.error).length, report: path.join(folder, 'Results.md') }));
