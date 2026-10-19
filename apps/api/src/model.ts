import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ExamSchema, MarksEvidenceSchema, QuestionSchema, RubricCriterionSchema, CriterionAwardSchema, TranscriptionSchema, StudentIdentitySchema, ResolutionSchema, ResultSchema, GradingSchema, type Exam, type Transcription, type Resolution, type Usage } from '@poc/shared';
import { createHash } from 'node:crypto';
import { validateExam } from './validation.js';
import { extractionPrompt, transcriptionPrompt, gradingPrompt, resolutionPrompt } from './prompts.js';
import { AppError } from './errors.js';

export type ModelResponse = { value: unknown; usage: Usage; examReused?: boolean };
export interface EvaluationModel {
  stageModels?: Record<string, string>;
  clearExamCache?(): void;
  extract(questionPaper: Buffer, answerKey: Buffer): Promise<ModelResponse>;
  transcribe(answerSheet: Buffer): Promise<ModelResponse>;
  resolve(answerSheet: Buffer, questions: Array<{ identifier: string; text: string }>, transcription: Transcription): Promise<ModelResponse>;
  grade(exam: Exam, transcription: Transcription, resolution?: Resolution): Promise<ModelResponse>;
}
export function createStageRoutedModel(reading: EvaluationModel, grading: EvaluationModel): EvaluationModel {
  return {
    stageModels: { extracting_exam: 'gpt-6-luna', transcribing: 'gpt-6-luna', resolving_answers: 'gpt-6-luna', evaluating: 'gpt-6.1-sol' },
    extract: (paper, key) => reading.extract(paper, key),
    transcribe: sheet => reading.transcribe(sheet),
    resolve: (sheet, questions, transcription) => reading.resolve(sheet, questions, transcription),
    grade: (exam, transcription, resolution) => grading.grade(exam, transcription, resolution),
    clearExamCache: () => { reading.clearExamCache?.(); grading.clearExamCache?.(); },
  };
}
const pdf = (filename: string, bytes: Buffer) => ({ type: 'input_file' as const, filename, file_data: `data:application/pdf;base64,${bytes.toString('base64')}`, detail: 'high' as const });
export class OpenAIModel implements EvaluationModel {
  private examCache = new Map<string, { exam: Exam; expires: number }>();
  constructor(private client: OpenAI, private model: string, private options: { parallelGrading?: boolean; gradingConcurrency?: number; serviceTier?: 'ultrafast'; examStorage?: { get(key: string): Promise<Exam | null>; set(key: string, exam: Exam): Promise<void> } } = {}) {}
  get stageModels() { return Object.fromEntries(['extracting_exam', 'transcribing', 'resolving_answers', 'evaluating'].map(stage => [stage, this.model])); }
  clearExamCache() { this.examCache.clear(); }
  withServiceTier(serviceTier: 'ultrafast') {
    const model = new OpenAIModel(this.client, this.model, { ...this.options, serviceTier });
    // Same model, documents and extraction instructions: reuse the fixed rubric
    // when switching service tier instead of generating a different allocation.
    model.examCache = this.examCache;
    return model;
  }
  private async call(schema: z.ZodTypeAny, name: string, instructions: string, content: Array<ReturnType<typeof pdf> | { type: 'input_text'; text: string }>): Promise<ModelResponse> {
    const response = await this.client.responses.create({
      model: this.model, store: false, instructions, input: [{ role: 'user', content }],
      // The installed SDK's tier union predates the documented Ultrafast tier.
      // Send the official wire value; do not substitute a model or service tier.
      ...(this.options.serviceTier ? { service_tier: this.options.serviceTier as OpenAI.Responses.ResponseCreateParamsNonStreaming['service_tier'] } : {}),
      text: { format: zodTextFormat(schema, name) },
    });
    if (response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal'))) throw new AppError('MODEL_REFUSAL', 'The model refused this request. Inspect the input documents before retrying.');
    if (response.status !== 'completed') throw new AppError('MODEL_INCOMPLETE', 'The model response was incomplete. Try a smaller PDF or check model limits.');
    let value: unknown;
    try { value = JSON.parse(response.output_text); }
    catch { throw new AppError('INVALID_MODEL_RESULT', 'The model did not return valid structured JSON.'); }
    if (!schema.safeParse(value).success) throw new AppError('INVALID_MODEL_RESULT', 'The model response did not match the expected schema.');
    return { value, usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, totalTokens: response.usage?.total_tokens ?? 0 } };
  }
  async extract(questionPaper: Buffer, answerKey: Buffer) {
    const fingerprint = createHash('sha256').update(createHash('sha256').update(questionPaper).digest()).update(createHash('sha256').update(answerKey).digest()).update(this.model).update(extractionPrompt).digest('hex');
    const cached = this.examCache.get(fingerprint);
    if (cached && cached.expires > Date.now()) return { value: structuredClone(cached.exam), examReused: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    const saved = await this.options.examStorage?.get(fingerprint);
    if (saved) return { value: structuredClone(validateExam(saved)), examReused: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    for (const [id, entry] of this.examCache) if (entry.expires <= Date.now()) this.examCache.delete(id);
    const schema = ExamSchema.extend({ marksEvidence: MarksEvidenceSchema.nullable(), questions: z.array(QuestionSchema.extend({ rubric: z.array(RubricCriterionSchema) })) });
    const response = await this.call(schema, 'exam_with_rubric', extractionPrompt, [
      { type: 'input_text', text: 'Question paper:' }, pdf('question-paper.pdf', questionPaper),
      { type: 'input_text', text: 'Answer key:' }, pdf('answer-key.pdf', answerKey),
    ]);
    const exam = validateExam(response.value);
    if (this.examCache.size >= 20) this.examCache.delete(this.examCache.keys().next().value!);
    this.examCache.set(fingerprint, { exam, expires: Date.now() + 3600000 });
    await this.options.examStorage?.set(fingerprint, exam);
    return { ...response, value: structuredClone(exam) };
  }
  transcribe(answerSheet: Buffer) {
    return this.call(TranscriptionSchema.extend({ studentIdentity: StudentIdentitySchema }), 'transcription', transcriptionPrompt, [pdf('answer-sheet.pdf', answerSheet)]);
  }
  resolve(answerSheet: Buffer, questions: Array<{ identifier: string; text: string }>, transcription: Transcription) {
    // Project fields here as well as in the pipeline: never leak the key to reading.
    const paper = questions.map(({ identifier, text }) => ({ identifier, text }));
    return this.call(ResolutionSchema, 'answer_resolution', resolutionPrompt, [pdf('answer-sheet.pdf', answerSheet), { type: 'input_text', text: JSON.stringify({ questions: paper, transcription }) }]);
  }
  async grade(exam: Exam, transcription: Transcription, resolution?: Resolution) {
    if (!this.options.parallelGrading || exam.questions.length <= 1) return this.gradeRequest(exam, transcription, resolution);
    // Keep full reading/mapping context so ambiguous or unmatched content cannot
    // turn an answer into a falsely unattempted question. Only the scoring target
    // and rubric are narrowed. Drain all in-flight calls before releasing the run.
    const concurrency = Math.max(1, Math.min(3, Math.floor(this.options.gradingConcurrency ?? 3)));
    const responses: ModelResponse[] = [];
    for (let index = 0; index < exam.questions.length; index += concurrency) {
      const batch = await Promise.allSettled(exam.questions.slice(index, index + concurrency).map(question =>
        this.gradeRequest({ ...exam, questions: [question] }, transcription, resolution)));
      const failure = batch.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      responses.push(...batch.map(result => (result as PromiseFulfilledResult<ModelResponse>).value));
    }
    const values = responses.map(response => GradingSchema.parse(response.value));
    return {
      value: GradingSchema.parse({ results: values.flatMap(value => value.results), warnings: [...new Set(values.flatMap(value => value.warnings))] }),
      usage: responses.reduce((sum, response) => ({ inputTokens: sum.inputTokens + response.usage.inputTokens, outputTokens: sum.outputTokens + response.usage.outputTokens, totalTokens: sum.totalTokens + response.usage.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    };
  }
  private async gradeRequest(exam: Exam, transcription: Transcription, resolution?: Resolution) {
    // Required keyed fields prevent the model omitting a difficult question's
    // uncertainty assessments. Convert to the public array contract at this boundary.
    const questions = Object.fromEntries(exam.questions.map(q => {
      const decisions = Object.fromEntries(transcription.answers.filter(a => a.identifier === q.identifier).flatMap(a => a.uncertainties).map(u => [u.id, z.object({ affectsMarks: z.boolean(), reason: z.string() }).strict()]));
      const base = ResultSchema.omit({ teacherAdjustment: true, marks: true, provisionalMarks: true, criterionAwards: true }).extend({ identifier: z.literal(q.identifier), maximumMarks: z.literal(q.maximumMarks), uncertaintyDecisions: z.object(decisions).strict() });
      return [q.identifier, q.rubric?.length ? base.extend({ criterionAwards: z.object(Object.fromEntries(q.rubric.map(c => [c.id, CriterionAwardSchema.omit({ criterionId: true }).strict()]))).strict() }).strict() : base.extend({ assessedMarks: z.number().nullable() }).strict()];
    }));
    const schema = z.object({ results: z.object(questions).strict(), warnings: z.array(z.string()) }).strict();
    const { studentIdentity: _identity, ...gradingTranscription } = transcription;
    const response = await this.call(schema, 'grading', gradingPrompt, [{ type: 'input_text', text: JSON.stringify({ exam, transcription: gradingTranscription, resolution }) }]);
    const value = schema.parse(response.value);
    const results = Object.values(value.results).map(result => {
      const r = result as any;
      const awards = r.criterionAwards ? Object.entries(r.criterionAwards).map(([criterionId, award]) => ({ criterionId, ...(award as object) })) : undefined;
      const score = awards ? (awards.some((a: any) => a.marks === null) ? null : Math.round(awards.reduce((sum: number, a: any) => sum + a.marks, 0) * 10000) / 10000) : r.assessedMarks;
      const { assessedMarks: _score, criterionAwards: _awards, ...rest } = r;
      return { ...rest, ...(awards ? { criterionAwards: awards } : {}), marks: r.status === 'needs_review' ? null : score, provisionalMarks: r.status === 'needs_review' ? score : null, uncertaintyDecisions: Object.entries(r.uncertaintyDecisions).map(([uncertaintyId, d]) => ({ uncertaintyId, ...(d as object) })) };
    });
    return { ...response, value: GradingSchema.parse({ results, warnings: value.warnings }) };
  }
}
