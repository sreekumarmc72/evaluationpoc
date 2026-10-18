import { z } from 'zod';

export const uploadFields = ['questionPaper', 'answerKey', 'answerSheet'] as const;
export type UploadField = typeof uploadFields[number];
export const selectableModels = ['gpt-6.1-sol', 'gpt-6-luna', 'luna-sol', 'sol-ultrafast'] as const;
export const modelLabels: Record<string, string> = {
  'gpt-6.1-sol': 'GPT-6.1 Sol · all stages',
  'gpt-6-luna': 'GPT-6 Luna · all stages',
  'luna-sol': 'Luna reading + Sol grading',
  'sol-ultrafast': 'GPT-6.1 Sol · all stages · Ultrafast',
};
export const stages = ['validating', 'reading_documents', 'extracting_exam', 'transcribing', 'resolving_answers', 'evaluating', 'completed', 'failed'] as const;
export const isTerminal = (stage: string) => stage === 'completed' || stage === 'failed';
export const RubricCriterionSchema = z.object({
  id: z.string(), description: z.string(), maximumMarks: z.number(),
  expectedEvidence: z.string(), keyAlignment: z.string(), allocationBasis: z.enum(['supplied', 'inferred']),
});
export const CriterionAwardSchema = z.object({
  criterionId: z.string(), marks: z.number().nullable(), evidence: z.string(), reason: z.string(), sourceEntryIds: z.array(z.string()),
});
export const QuestionSchema = z.object({
  identifier: z.string(), text: z.string(), maximumMarks: z.number(),
  expectedAnswer: z.string(), acceptedAlternatives: z.array(z.string()),
  markingCriteria: z.array(z.string()), gradingBasis: z.enum(['supplied', 'inferred']),
  rubric: z.array(RubricCriterionSchema).optional(),
});
export const ExamSchema = z.object({
  policyVersion: z.string().nullable(),
  questions: z.array(QuestionSchema), optionalQuestions: z.boolean(),
  issues: z.array(z.string()), warnings: z.array(z.string()),
});
export const UncertaintySchema = z.object({
  id: z.string(), description: z.string(), sourcePages: z.array(z.number().int()),
  scope: z.enum(['final_answer', 'crossed_out', 'presentation', 'mapping']),
  impact: z.enum(['non_material', 'potentially_score_changing']),
});
export const AnswerSchema = z.object({
  entryId: z.string(),
  identifier: z.string().nullable(), text: z.string(), sourcePages: z.array(z.number().int()),
  uncertaintyNotes: z.array(z.string()), unsupportedContent: z.boolean(),
  uncertainties: z.array(UncertaintySchema),
});
export const StudentIdentitySchema = z.object({
  name: z.string().max(160).nullable(), status: z.enum(['readable', 'unclear', 'absent']),
  sourcePages: z.array(z.number().int().positive()), note: z.string().max(1000),
});
export const TranscriptionSchema = z.object({
  studentIdentity: StudentIdentitySchema.optional(),
  answers: z.array(AnswerSchema), pagesRead: z.array(z.number().int()),
  allPagesRead: z.boolean(), warnings: z.array(z.string()),
});
export const ResolutionSchema = z.object({
  mappings: z.array(z.object({ entryId: z.string(), questionId: z.string().nullable(), candidateQuestionIds: z.array(z.string()), evidence: z.string() })),
  readings: z.array(z.object({ entryId: z.string(), originalText: z.string(), revisedText: z.string(), sourcePages: z.array(z.number().int()), evidence: z.string() })),
  warnings: z.array(z.string()),
});
export const ResultSchema = z.object({
  identifier: z.string(), maximumMarks: z.number(), marks: z.number().nullable(),
  status: z.enum(['graded', 'unattempted', 'needs_review']), justification: z.string(),
  correctPoints: z.array(z.string()), missingPoints: z.array(z.string()), reviewFlags: z.array(z.string()),
  notes: z.array(z.string()),
  criterionAwards: z.array(CriterionAwardSchema).optional(),
  provisionalMarks: z.number().nullable().optional(),
  teacherAdjustment: z.object({ marks: z.number(), reason: z.string(), updatedAt: z.number() }).optional(),
  uncertaintyDecisions: z.array(z.object({ uncertaintyId: z.string(), affectsMarks: z.boolean(), reason: z.string() })),
});
export const GradingSchema = z.object({ results: z.array(ResultSchema), warnings: z.array(z.string()) });
export const TotalsSchema = z.object({
  maximumMarks: z.number(), gradedSubtotal: z.number(), totalMarks: z.number().nullable(),
  percentage: z.number().nullable(), pendingQuestions: z.array(z.string()),
  provisionalTotal: z.number().nullable().optional(), provisionalPercentage: z.number().nullable().optional(),
});
export const UsageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() });
export const RunErrorSchema = z.object({ code: z.string(), message: z.string(), stage: z.enum(stages) });
export const RunSchema = z.object({
  durable: z.boolean().optional(),
  id: z.string(), stage: z.enum(stages), createdAt: z.number(), finishedAt: z.number().nullable(),
  exam: ExamSchema.nullable(), transcription: TranscriptionSchema.nullable(),
  resolution: ResolutionSchema.nullable(), resolvedTranscription: TranscriptionSchema.nullable(),
  results: z.array(ResultSchema), totals: TotalsSchema.nullable(), warnings: z.array(z.string()),
  error: RunErrorSchema.nullable(), model: z.string(), usage: UsageSchema,
  stageDurations: z.record(z.number()),
  stageModels: z.record(z.string()).optional(),
  examReused: z.boolean().optional(),
  examId: z.string().optional(), examVersion: z.number().int().optional(),
});
export type Exam = z.infer<typeof ExamSchema>;
export type Transcription = z.infer<typeof TranscriptionSchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
export type Grading = z.infer<typeof GradingSchema>;
export type QuestionResult = z.infer<typeof ResultSchema>;
export type EvaluationRun = z.infer<typeof RunSchema>;
export type Totals = z.infer<typeof TotalsSchema>;
export type Usage = z.infer<typeof UsageSchema>;

export const PreparedExamSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120), version: z.number().int().positive(),
  status: z.enum(['preparing', 'ready', 'failed']), model: z.enum(['gpt-6.1-sol', 'sol-ultrafast']),
  preparationModel: z.enum(['gpt-6.1-sol', 'sol-ultrafast']).optional(),
  submissionCount: z.number().int().nonnegative().optional(),
  createdAt: z.number(), finishedAt: z.number().nullable(),
  documents: z.object({ questionPaper: z.object({ name: z.string(), pages: z.number(), sha256: z.string() }), answerKey: z.object({ name: z.string(), pages: z.number(), sha256: z.string() }) }),
  questionCount: z.number().int(), maximumMarks: z.number(), usage: UsageSchema, durationMs: z.number(),
  warnings: z.array(z.string()), error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PreparedExam = z.infer<typeof PreparedExamSchema>;
export const SubmissionSummarySchema = z.object({
  id: z.string().uuid(), createdAt: z.number(), stage: z.enum(stages), model: z.string(), totals: TotalsSchema.nullable(),
  studentName: z.string().nullable(), nameStatus: z.enum(['readable', 'unclear', 'absent']), interrupted: z.boolean(), error: z.string().nullable(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;
