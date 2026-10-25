import OpenAI from 'openai';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { TranscriptionSchema, type Exam, type QuestionResult, type Totals, type Transcription } from '@poc/shared';
import { config } from '../config.js';
import { OpenAIModel } from '../model.js';
import { validatePdf } from '../pdf.js';
import { validateExam, validateTranscription, validateGrading, directResolution, applyResolution } from '../validation.js';
import { evaluateDocuments } from '../evaluation.js';
import { publicError } from '../errors.js';

const ReferenceSchema = z.object({
  mode: z.enum(['baseline', 'calibration']).default('baseline'),
  repetitions: z.number().int().min(1).max(10).default(1),
  isolatedGrading: z.boolean().default(false),
  gradingComparisonOnly: z.boolean().default(false),
  policyVersion: z.string().optional(), provenance: z.string().optional(),
  questionPaper: z.string(), answerKey: z.string(),
  cases: z.array(z.object({ name: z.string(), answerSheet: z.string(),
    referenceTranscription: TranscriptionSchema.optional(),
    referenceAnswers: z.array(z.object({ identifier: z.string(), text: z.string(), marks: z.number().nullable() })),
  })).min(2),
});
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
function compare(sample: z.infer<typeof ReferenceSchema>['cases'][number], results: QuestionResult[], totals: Totals, t: Transcription) {
  const comparisons = sample.referenceAnswers.map(ref => {
    const text = t.answers.filter(a => a.identifier === ref.identifier).map(a => a.text).join('\n\n');
    const result = results.find(r => r.identifier === ref.identifier);
    const observed = result?.marks ?? null;
    return { identifier: ref.identifier, expectedMarks: ref.marks, observedMarks: observed, markDifference: observed === null || ref.marks === null ? null : observed - ref.marks,
      provisionalMarks: result?.provisionalMarks ?? null, proposedMarkDifference: ref.marks === null || (observed ?? result?.provisionalMarks) == null ? null : (observed ?? result!.provisionalMarks!) - ref.marks,
      characterErrorRate: distance(ref.text, text) / Math.max(ref.text.length, 1) };
  });
  const humanTotal = sample.referenceAnswers.some(r => r.marks === null) ? null : sample.referenceAnswers.reduce((sum, r) => sum + r.marks!, 0);
  return { comparisons, humanTotal, observedTotal: totals.totalMarks, totalDifference: humanTotal === null || totals.totalMarks === null ? null : totals.totalMarks - humanTotal };
}
function validateReferences(exam: Exam, sample: z.infer<typeof ReferenceSchema>['cases'][number]) {
  const ids = sample.referenceAnswers.map(a => a.identifier);
  if (new Set(ids).size !== ids.length || ids.length !== exam.questions.length || exam.questions.some(q => !ids.includes(q.identifier))) throw new Error('Reference questions must match the exam exactly.');
  for (const answer of sample.referenceAnswers) {
    const maximum = exam.questions.find(q => q.identifier === answer.identifier)!.maximumMarks;
    if (answer.marks !== null && (answer.marks < 0 || answer.marks > maximum)) throw new Error('Invalid reference marks.');
    if (answer.text.includes('REPLACE with human')) throw new Error('Replace template reference transcriptions.');
  }
}
try {
  if (!config.apiKey || !config.model) throw new Error('Configure the backend API key and model.');
  if (!process.argv[2]) throw new Error('Usage: npm run baseline -- manifest.json [output-directory]');
  const absolute = path.resolve(process.argv[2]); const base = path.dirname(absolute);
  const reference = ReferenceSchema.parse(JSON.parse(await readFile(absolute, 'utf8')));
  if (reference.mode === 'baseline' && reference.cases.length < 5) throw new Error('The broad baseline requires at least five sheets; use mode=calibration for the two-sheet study.');
  if (reference.isolatedGrading && reference.cases.some(c => !c.referenceTranscription)) throw new Error('Isolated grading requires checked referenceTranscription for every case.');
  const load = async (file: string) => { const buffer = await readFile(path.resolve(base, file)); const pages = await validatePdf(buffer, file, config.maxBytes, config.maxPages); return { buffer, pages }; };
  const paper = await load(reference.questionPaper); const key = await load(reference.answerKey);
  const model = new OpenAIModel(new OpenAI({ apiKey: config.apiKey, timeout: config.timeout, maxRetries: 2 }), config.model, { pageReading: true, blueprintPreparation: true });
  const output = path.resolve(process.argv[3] ?? 'baseline-output'); await mkdir(output, { recursive: true });
  const reports: any[] = [];
  const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify({ pipelineVersion: 'concise-grading-v1', model: reference.gradingComparisonOnly ? 'gpt-6.1-sol' : config.model, extractionModel: reference.gradingComparisonOnly ? 'gpt-6-luna' : config.model, policyVersion: reference.policyVersion ?? null, answerKeySha256: createHash('sha256').update(key.buffer).digest('hex'), provenance: reference.provenance, createdAt: new Date().toISOString(), reports }, null, 2));
  if (reference.gradingComparisonOnly) {
    if (reference.cases.some(sample => !sample.referenceTranscription)) throw new Error('Grading comparison needs checked transcriptions.');
    // A single fixed Luna rubric isolates Sol grading latency from extraction and
    // reading differences, matching mixed-mode routing in the application.
    const client = new OpenAI({ apiKey: config.apiKey, timeout: config.timeout, maxRetries: 2 });
    const exam = validateExam((await new OpenAIModel(client, 'gpt-6-luna').extract(paper.buffer, key.buffer)).value);
    if (reference.policyVersion && exam.policyVersion !== reference.policyVersion) throw new Error('Extracted marking-policy version mismatch.');
    const graders = { concise_sequential: new OpenAIModel(client, 'gpt-6.1-sol'), concise_parallel: new OpenAIModel(client, 'gpt-6.1-sol', { parallelGrading: true }) };
    for (const sample of reference.cases) {
      validateReferences(exam, sample);
      const sheet = await load(sample.answerSheet);
      const raw = validateTranscription(sample.referenceTranscription!, sheet.pages);
      const resolution = directResolution(raw, exam); const transcription = applyResolution(raw, resolution);
      for (const [strategy, grader] of Object.entries(graders)) {
        console.log(`Grading comparison: ${sample.name}, ${strategy}`);
        const started = Date.now();
        try {
          const response = await grader.grade(exam, transcription, resolution);
          const grading = validateGrading(response.value, exam, transcription, resolution);
          reports.push({ name: sample.name, phase: strategy, durationMs: Date.now() - started, ...compare(sample, grading.results, grading.totals, transcription), exam, grading, usage: response.usage });
          console.log(JSON.stringify({ name: sample.name, strategy, seconds: (Date.now() - started) / 1000, marks: grading.results.map(r => r.marks ?? r.provisionalMarks), pending: grading.totals.pendingQuestions }));
        } catch (error) { reports.push({ name: sample.name, phase: strategy, durationMs: Date.now() - started, error: publicError(error).message }); }
        await save();
      }
    }
    console.log(`Comparison saved to ${path.join(output, 'report.json')}`);
    process.exit(0);
  }
  if (reference.isolatedGrading) {
    console.log('Extracting exam for isolated grading');
    const exam = validateExam((await model.extract(paper.buffer, key.buffer)).value);
    if (reference.policyVersion && exam.policyVersion !== reference.policyVersion) throw new Error('Extracted marking-policy version does not match the reference.');
    for (const sample of reference.cases) {
      validateReferences(exam, sample);
      console.log(`Isolated grading: ${sample.name}`);
      try {
        const sheet = await load(sample.answerSheet);
        const raw = validateTranscription(sample.referenceTranscription!, sheet.pages);
        const resolution = directResolution(raw, exam); const transcription = applyResolution(raw, resolution);
        const response = await model.grade(exam, transcription, resolution);
        const grading = validateGrading(response.value, exam, transcription, resolution);
        reports.push({ name: sample.name, phase: 'isolated_grading', attempt: 1, ...compare(sample, grading.results, grading.totals, transcription), exam, transcription, grading, usage: response.usage });
        console.log(JSON.stringify({ name: sample.name, phase: 'isolated_grading', total: grading.totals.totalMarks, marks: grading.results.map(r => r.marks) }));
      } catch (error) { reports.push({ name: sample.name, phase: 'isolated_grading', error: publicError(error).message }); }
      await save();
    }
  }
  for (const sample of reference.cases) for (let attempt = 1; attempt <= reference.repetitions; attempt++) {
    console.log(`End-to-end: ${sample.name}, attempt ${attempt}`);
    let lastStage = '';
    let diagnostics: unknown;
    try {
      const sheet = await load(sample.answerSheet);
      const evaluation = await evaluateDocuments(model, { questionPaper: paper.buffer, answerKey: key.buffer, answerSheet: sheet.buffer }, sheet.pages, p => { diagnostics = structuredClone(p); if (p.stage !== lastStage) { lastStage = p.stage; console.log(p.stage); } });
      validateReferences(evaluation.exam!, sample);
      if (reference.policyVersion && evaluation.exam!.policyVersion !== reference.policyVersion) throw new Error('Extracted policy version mismatch.');
      reports.push({ name: sample.name, phase: 'end_to_end', attempt, ...compare(sample, evaluation.results, evaluation.totals!, evaluation.resolvedTranscription!), evaluation });
      console.log(JSON.stringify({ name: sample.name, attempt, total: evaluation.totals!.totalMarks, marks: evaluation.results.map(r => r.marks) }));
    } catch (error) { reports.push({ name: sample.name, phase: 'end_to_end', attempt, failedStage: lastStage, error: publicError(error).message, diagnostics }); }
    await save();
  }
  console.log(`Report saved to ${path.join(output, 'report.json')}`);
} catch (error) { console.error(error instanceof Error && !(error instanceof OpenAI.APIError) ? error.message : publicError(error).message); process.exitCode = 1; }
