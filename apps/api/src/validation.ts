import { ExamSchema, examMaximumMarks, TranscriptionSchema, ResolutionSchema, GradingSchema, type Exam, type Transcription, type Resolution, type QuestionResult, type Totals } from '@poc/shared';
import { AppError } from './errors.js';
import { validateSelectionRules, applyOptionalSelection, optionalTotals, activeAnswers } from './optional-sections.js';
import { blueprintTotals } from './blueprint.js';

const fail = (message: string): never => { throw new AppError('INVALID_MODEL_RESULT', message); };
export function validateExam(value: unknown): Exam {
  const parsed = ExamSchema.safeParse(value);
  if (!parsed.success) return fail('The model returned an invalid exam specification.');
  const exam = parsed.data;
  validateSelectionRules(exam);
  if (exam.issues.length) throw new AppError('EXAM_ISSUES', `Cannot evaluate this exam: ${exam.issues.join('; ')}`);
  if (!exam.questions.length) return fail('No scored questions were found.');
  const ids = new Set<string>();
  for (const q of exam.questions) {
    if (!q.identifier.trim() || ids.has(q.identifier) || !q.text.trim() || !q.expectedAnswer.trim() || !Number.isFinite(q.maximumMarks) || q.maximumMarks <= 0) return fail('Questions must have unique IDs, text, an answer key, and positive maximum marks.');
    if (q.gradingBasis === 'supplied' && !q.markingCriteria.some(c => c.trim())) return fail(`Question ${q.identifier} has no supplied marking criteria.`);
    if (q.rubric !== undefined) {
      const rubricIds = new Set(q.rubric.map(c => c.id));
      if (!q.rubric.length || rubricIds.size !== q.rubric.length || q.rubric.some(c => !c.id.trim() || !c.description.trim() || !c.expectedEvidence.trim() || !c.keyAlignment.trim() || !Number.isFinite(c.maximumMarks) || c.maximumMarks <= 0)) return fail(`Invalid rubric criteria for question ${q.identifier}.`);
      if (Math.abs(q.rubric.reduce((sum, c) => sum + c.maximumMarks, 0) - q.maximumMarks) > 0.000001) return fail(`Rubric allocations must sum to the maximum marks for question ${q.identifier}.`);
    }
    ids.add(q.identifier);
  }
  const total = examMaximumMarks(exam);
  if (!Number.isFinite(total)) return fail('The maximum mark total is invalid.');
  if (!exam.blueprint) validateMarksEvidence(exam, total);
  return exam;
}
function validateMarksEvidence(exam: Exam, total: number) {
  const evidence = exam.marksEvidence;
  if (!evidence) return; // Existing prepared exams remain readable without rewriting them.
  const same = (a: number, b: number) => Math.abs(a - b) <= 0.000001;
  if (evidence.printedTotal !== null && (!evidence.totalSource.trim() || !same(total, evidence.printedTotal))) return fail('Question marks do not match the printed exam maximum or its source evidence is missing.');
  const seen = new Set<string>();
  const sectionIds = new Set<string>();
  for (const section of evidence.sections) {
    if (!section.identifier.trim() || sectionIds.has(section.identifier) || !section.heading.trim() || !section.sourcePages.length || !section.questions.length) return fail('Section marks need unique section IDs, headings, source pages and questions.');
    sectionIds.add(section.identifier);
    for (const item of section.questions) {
      const question = exam.questions.find(q => q.identifier === item.identifier);
      if (!question || seen.has(item.identifier)) return fail('Section marks reference an unknown or repeated question.');
      seen.add(item.identifier);
      if (item.printedMarks !== null && (!item.source.trim() || !same(item.printedMarks, question.maximumMarks))) return fail(`Question ${item.identifier} differs from its explicit printed marks or lacks source evidence.`);
    }
    const subtotal = exam.selectionGroups?.find(group => group.id === section.identifier)?.maximumMarks ?? section.questions.reduce((sum, item) => sum + exam.questions.find(q => q.identifier === item.identifier)!.maximumMarks, 0);
    if (section.headingScope === 'section_total' && (section.headingMarks === null || !same(subtotal, section.headingMarks))) return fail(`Section ${section.identifier} conflicts with its explicitly stated section total.`);
    if (section.headingScope === 'per_question' && (section.headingMarks === null || section.questions.some(item => !same(exam.questions.find(q => q.identifier === item.identifier)!.maximumMarks, section.headingMarks!)))) return fail(`Section ${section.identifier} conflicts with its explicit per-question heading.`);
  }
  for (const section of evidence.sections.filter(s => s.headingScope === 'ambiguous' && s.headingMarks !== null)) {
    if (exam.optionalQuestions) return fail('Ambiguous optional section headings require explicit selection and mark instructions.');
    const allExplicit = seen.size === exam.questions.length && evidence.sections.every(s => s.questions.every(q => q.printedMarks !== null && q.source.trim()));
    if (evidence.printedTotal === null || !allExplicit || section.questions.some(q => !same(q.printedMarks!, section.headingMarks!))) return fail(`Section ${section.identifier} has an ambiguous marks heading that cannot be reconciled from explicit question marks and the printed exam maximum.`);
    const subtotal = section.questions.reduce((sum, q) => sum + q.printedMarks!, 0);
    const warning = `Section ${section.identifier}: heading "${section.heading}" interpreted as ${section.headingMarks} marks per question; ${section.questions.length} explicit question allocations total ${subtotal}. All question allocations match the printed exam maximum of ${evidence.printedTotal}.`;
    if (!exam.warnings.includes(warning)) exam.warnings.push(warning);
  }
}
export function identifyTranscription(value: unknown): Transcription {
  const parsed = TranscriptionSchema.safeParse(value);
  if (!parsed.success) return fail('The model returned an invalid transcription.');
  const t = parsed.data;
  if (t.studentIdentity) {
    const identity = t.studentIdentity;
    identity.sourcePages = [...new Set(identity.sourcePages.filter(page => t.pagesRead.includes(page)))];
    if (identity.status !== 'readable' || !identity.name?.trim() || !identity.sourcePages.length) {
      identity.name = null;
      if (identity.status === 'readable') { identity.status = 'unclear'; identity.note = 'The reported name lacks readable evidence or valid page attribution.'; }
    } else identity.name = identity.name.trim();
  }
  for (const [i, a] of t.answers.entries()) {
    a.entryId = `entry-${i + 1}`;
    for (const [j, u] of a.uncertainties.entries()) u.id = `${a.entryId}-uncertainty-${j + 1}`;
  }
  return t;
}
export function validateTranscription(value: unknown, pageCount: number): Transcription {
  const t = identifyTranscription(value);
  const validPage = (p: number) => p >= 1 && p <= pageCount;
  if (t.pagesRead.some(p => !validPage(p)) || new Set(t.pagesRead).size !== t.pagesRead.length) return fail('Transcription contains invalid page references.');
  if (t.allPagesRead && t.pagesRead.length !== pageCount) return fail('Transcription claims complete coverage but is missing pages.');
  t.answers = t.answers.filter(a => {
    const labelOnly = !a.text.trim() && !a.unsupportedContent && a.sourcePages.length > 0
      && a.sourcePages.every(p => validPage(p) && t.pagesRead.includes(p))
      && a.uncertainties.length > 0
      && a.uncertainties.every(u => u.scope === 'mapping' && u.impact === 'non_material'
        && u.sourcePages.length > 0 && u.sourcePages.every(p => a.sourcePages.includes(p)))
      && a.uncertainties.some(u => /no (?:written )?answer (?:follows|content)|unanswered (?:question )?label/i.test(u.description));
    if (labelOnly) t.warnings.push(`Blank label-only entry ${a.entryId} on pages ${a.sourcePages.join(', ')} has no written answer content. Retained in raw transcription; excluded from answer mapping and grading.`);
    return !labelOnly;
  });
  for (const [index, a] of t.answers.entries()) {
    if (a.withdrawn && !a.withdrawalEvidence?.trim()) return fail('A withdrawn answer requires visible cancellation evidence.');
    if (!a.text.trim() || !a.sourcePages.length || a.sourcePages.some(p => !validPage(p) || !t.pagesRead.includes(p))) return fail(`Transcription entry ${a.entryId} (question label ${a.identifier ?? 'unmatched'}) needs written content and valid inspected source pages; reported pages: ${a.sourcePages.join(', ') || 'none'}.`);
    if (a.identifier === 'null') a.identifier = null;
    if (a.identifier !== null && !a.identifier.trim()) return fail('A transcribed question ID is empty.');
    for (const [j, u] of a.uncertainties.entries()) {
      if (!u.description.trim()) { u.description = 'The model reported an unspecified reading uncertainty.'; u.scope = 'final_answer'; u.impact = 'potentially_score_changing'; }
      if (!u.sourcePages.length || u.sourcePages.some(p => !a.sourcePages.includes(p))) {
        t.warnings.push(`Uncertainty ${u.id} had missing or inconsistent page attribution (${u.sourcePages.join(', ') || 'none'}); it is conservatively scoped to entry pages ${a.sourcePages.join(', ')}. Original annotation is retained in the raw transcription.`);
        u.sourcePages = [...a.sourcePages];
      }
    }
    // Legacy free-text warnings cannot bypass structured uncertainty assessment.
    if (!a.uncertainties.length && a.uncertaintyNotes.length) a.uncertainties = a.uncertaintyNotes.map((description, j) => ({ id: `${a.entryId}-uncertainty-${j + 1}`, description, sourcePages: a.sourcePages, scope: 'final_answer', impact: 'potentially_score_changing' }));
  }
  return t;
}
const round = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
function canonicalId(id: string | null, exam: Exam): string | null {
  if (id === null) return null;
  if (exam.questions.some(q => q.identifier === id)) return id;
  const parent = id.match(/^(.+)\(([a-z]+|\d+)\)$/i)?.[1];
  return parent && exam.questions.some(q => q.identifier === parent) && !exam.questions.some(q => q.identifier.startsWith(parent + '(')) ? parent : null;
}
export function directResolution(t: Transcription, exam: Exam): Resolution {
  return { mappings: t.answers.map(a => {
    const questionId = canonicalId(a.identifier, exam);
    return { entryId: a.entryId, questionId, candidateQuestionIds: questionId ? [questionId] : [], evidence: questionId ? `Visible source label ${a.identifier} on pages ${a.sourcePages.join(', ')} maps to scoring unit ${questionId}.` : 'No canonical visible question label; association remains unresolved.' };
  }), readings: [], warnings: [] };
}
export function needsResolution(t: Transcription, exam: Exam): boolean {
  const labels = t.answers.map(a => a.identifier).filter(id => id !== null);
  return new Set(labels).size !== labels.length || t.answers.some(a => !canonicalId(a.identifier, exam) || a.uncertainties.some(u => u.impact === 'potentially_score_changing'));
}
export function validateResolution(value: unknown, t: Transcription, exam: Exam): Resolution {
  const parsed = ResolutionSchema.safeParse(value);
  if (!parsed.success) return fail('The model returned invalid answer resolution.');
  const resolution = parsed.data;
  const entries = new Map(t.answers.map(a => [a.entryId, a]));
  const ids = new Set(exam.questions.map(q => q.identifier));
  const seen = new Set<string>();
  if (resolution.mappings.length !== entries.size) return fail('Resolution must include every transcription entry exactly once.');
  for (const m of resolution.mappings) {
    // Empty/null strings are never valid question IDs. Conservatively retain
    // these associations as unresolved; never guess an established target.
    if (m.questionId !== null && (!m.questionId.trim() || m.questionId.trim().toLowerCase() === 'null')) {
      m.questionId = null; resolution.warnings.push(`Entry ${m.entryId}: an empty question reference was retained as an unresolved association.`);
    }
    if (!entries.has(m.entryId) || seen.has(m.entryId) || !m.evidence.trim()) return fail('Resolution contains duplicate, unknown or unsupported entries.');
    seen.add(m.entryId);
    if (new Set(m.candidateQuestionIds).size !== m.candidateQuestionIds.length || m.candidateQuestionIds.some(id => !ids.has(id))) return fail('Resolution candidates contain invalid question IDs.');
    if (m.questionId !== null && (!ids.has(m.questionId) || m.candidateQuestionIds.length !== 1 || m.candidateQuestionIds[0] !== m.questionId)) return fail('An established mapping must identify exactly one valid question.');
  }
  const edited = new Map<string, Array<[number, number]>>();
  for (const reading of resolution.readings) {
    const a = entries.get(reading.entryId);
    const at = a?.text.indexOf(reading.originalText) ?? -1;
    if (!a || !reading.originalText.trim() || !reading.revisedText.trim() || !reading.evidence.trim() || at < 0 || a.text.indexOf(reading.originalText, at + 1) >= 0 || !reading.sourcePages.length || reading.sourcePages.some(p => !a.sourcePages.includes(p))) return fail('A verified reading needs unique original text and valid source-page evidence.');
    const ranges = edited.get(a.entryId) ?? [];
    const end = at + reading.originalText.length;
    if (ranges.some(([start, finish]) => at < finish && end > start)) return fail('Verified readings must not overlap.');
    ranges.push([at, end]); edited.set(a.entryId, ranges);
  }
  return resolution;
}
export function applyResolution(t: Transcription, resolution: Resolution): Transcription {
  return { ...t, answers: t.answers.map(a => {
    const edits = resolution.readings.filter(r => r.entryId === a.entryId).sort((x, y) => a.text.indexOf(y.originalText) - a.text.indexOf(x.originalText));
    let text = a.text;
    for (const r of edits) { const at = a.text.indexOf(r.originalText); text = text.slice(0, at) + r.revisedText + text.slice(at + r.originalText.length); }
    return { ...a, text, identifier: resolution.mappings.find(m => m.entryId === a.entryId)!.questionId };
  }) };
}
export function validateGrading(value: unknown, exam: Exam, transcription: Transcription, suppliedResolution?: Resolution, originalTranscription: Transcription = transcription): { results: QuestionResult[]; totals: Totals; warnings: string[] } {
  if (new Set(transcription.answers.map(a => a.entryId)).size !== transcription.answers.length) return fail('Transcription entry IDs must be unique; duplicate entries cannot be scored twice.');
  const resolution = validateResolution(suppliedResolution ?? directResolution(transcription, exam), originalTranscription, exam);
  const parsed = GradingSchema.safeParse(value);
  if (!parsed.success) return fail('The model returned malformed grades.');
  const grading = parsed.data;
  const active = activeAnswers(transcription, exam);
  const activeIds = new Set(active.map(a => a.entryId));
  const expected = new Map(exam.questions.map(q => [q.identifier, q]));
  const found = new Set<string>();
  if (grading.results.length !== expected.size) return fail('The grading response must include exactly one entry per question.');
  for (const r of grading.results) {
    delete r.selectionStatus; delete r.selectionNote; // Selection is application-owned.
    const q = expected.get(r.identifier);
    if (!q || found.has(r.identifier)) return fail('The grading response contains unknown or duplicate question IDs.');
    found.add(r.identifier);
    if (q.rubric?.length) {
      const awards = r.criterionAwards;
      if (!awards || awards.length !== q.rubric.length || new Set(awards.map(a => a.criterionId)).size !== awards.length) return fail(`Missing or duplicate rubric awards for question ${q.identifier}.`);
      const mappedIds = new Set(resolution.mappings.filter(m => m.questionId === q.identifier && activeIds.has(m.entryId)).map(m => m.entryId));
      for (const a of awards) {
        const c = q.rubric.find(c => c.id === a.criterionId);
        if (!c || !a.reason.trim() || (a.marks !== null && (!Number.isFinite(a.marks) || a.marks < 0 || a.marks > c.maximumMarks)) || new Set(a.sourceEntryIds).size !== a.sourceEntryIds.length || a.sourceEntryIds.some(id => !mappedIds.has(id)) || (a.marks !== null && a.marks > 0 && (!a.evidence.trim() || !a.sourceEntryIds.length))) return fail(`Invalid rubric award or evidence for question ${q.identifier}.`);
      }
      const score = awards.every(a => a.marks === null) ? null : round(awards.reduce((sum, a) => sum + (a.marks ?? 0), 0));
      if (awards.some(a => a.marks === null)) {
        r.status = 'needs_review';
        r.reviewFlags.push('Some rubric criteria could not be assessed. Provisional marks include only assessed criteria; review the remaining allocations.');
      }
      r.marks = r.status === 'needs_review' ? null : score;
      r.provisionalMarks = r.status === 'needs_review' ? score : null;
    } else if (r.criterionAwards?.length) return fail(`Unexpected rubric awards for question ${q.identifier}.`);
    delete r.teacherAdjustment; // Human adjustments may only come from the review endpoint.
    if (r.provisionalMarks != null && (!Number.isFinite(r.provisionalMarks) || r.provisionalMarks < 0 || r.provisionalMarks > q.maximumMarks)) return fail(`Invalid provisional marks for question ${r.identifier}.`);
    if (r.maximumMarks !== q.maximumMarks || (r.marks !== null && (!Number.isFinite(r.marks) || r.marks < 0 || r.marks > q.maximumMarks))) return fail(`Invalid marks for question ${r.identifier}.`);
    if ((r.status === 'needs_review') !== (r.marks === null) || (r.status === 'unattempted' && r.marks !== 0)) {
      r.status = 'needs_review';
      r.provisionalMarks = r.marks ?? r.provisionalMarks;
      r.marks = null;
      r.reviewFlags.push('The model status required review; its numeric proposal is retained provisionally.');
    }
    if (!r.justification.trim()) {
      r.status = 'needs_review';
      r.marks = null;
      r.provisionalMarks = null;
      r.justification = 'The model did not explain its grading decision. The proposed score has been withheld pending review.';
      r.reviewFlags.push('Missing model justification.');
    }
  }
  // Conservative application guard: model grades cannot override uncertainty in the source.
  const globalFlags: string[] = [];
  if (!transcription.allPagesRead) globalFlags.push('Not all answer-sheet pages could be read.');
  // Warnings include informational scan observations. Blocking uncertainty belongs
  // in incomplete coverage or the affected answer's uncertaintyNotes.
  const unresolved = resolution.mappings.filter(m => m.questionId === null && activeIds.has(m.entryId));
  const results = exam.questions.map(q => {
    const r = grading.results.find(entry => entry.identifier === q.identifier)!;
    const entryIds = new Set(resolution.mappings.filter(m => m.questionId === q.identifier).map(m => m.entryId));
    const answers = active.filter(a => entryIds.has(a.entryId));
    const flags = [...globalFlags];
    const ambiguousMapping = unresolved.some(m => m.candidateQuestionIds.includes(q.identifier));
    if (ambiguousMapping) flags.push('Some answer content has an unresolved association with this question.');
    const uncertainties = answers.flatMap(a => a.uncertainties);
    const uncertaintyIds = new Set(uncertainties.map(u => u.id));
    if (new Set(r.uncertaintyDecisions.map(d => d.uncertaintyId)).size !== r.uncertaintyDecisions.length || r.uncertaintyDecisions.some(d => !uncertaintyIds.has(d.uncertaintyId) || !d.reason.trim())) return fail(`Invalid uncertainty decisions for question ${q.identifier}.`);
    for (const u of uncertainties) {
      const decision = r.uncertaintyDecisions.find(d => d.uncertaintyId === u.id);
      if (!decision) flags.push(`Uncertainty was not assessed: ${u.description}`);
      else if (u.impact === 'potentially_score_changing' && decision.affectsMarks) flags.push(`${u.description}: ${decision.reason}`);
      else r.notes.push(`Reading note: ${u.description}. ${decision.reason}`);
    }
    // Legacy notes without structured uncertainties stay conservative.
    if (!uncertainties.length && answers.some(a => a.uncertaintyNotes.length)) flags.push(...answers.flatMap(a => a.uncertaintyNotes));
    if (answers.some(a => a.unsupportedContent)) flags.push('Answer contains unsupported content such as a diagram.');
    if (answers.some(a => /\[illegible\]/i.test(a.text) && !a.uncertainties.length)) flags.push('Answer contains unassessed illegible text.');
    // Review of an additional fragment does not erase awards already supported
    // by established sources. The fragment itself still earns no mapped credit.
    if (flags.length) return { ...r, provisionalMarks: r.marks ?? r.provisionalMarks, status: 'needs_review' as const, marks: null, reviewFlags: [...new Set([...r.reviewFlags, ...flags])] };
    if (!answers.length && unresolved.some(m => !m.candidateQuestionIds.length)) return { ...r, status: 'needs_review' as const, marks: null, reviewFlags: [...r.reviewFlags, 'Unmapped content prevents establishing that this question was unattempted.'] };
    if (!answers.length) return { ...r, status: 'unattempted' as const, marks: 0, justification: 'No answer for this question was found in the complete, unambiguously mapped transcription.', correctPoints: [], missingPoints: ['Question not attempted.'], reviewFlags: [] };
    if (r.status === 'unattempted') return { ...r, status: 'needs_review' as const, marks: null, reviewFlags: [...r.reviewFlags, 'The model classified an existing answer as unattempted; its proposed score was withheld.'] };
    if (r.status === 'needs_review' && !r.reviewFlags.length) r.reviewFlags.push('The model could not provide a reliable score. Review the answer and justification.');
    return r;
  });
  if (exam.blueprint) return { results, warnings: grading.warnings, totals: blueprintTotals(results, exam, transcription, resolution) };
  applyOptionalSelection(results, exam, transcription, resolution);
  return { results, warnings: grading.warnings, totals: calculateTotals(results, exam) };
}
export function calculateTotals(results: QuestionResult[], exam?: Exam | null): Totals {
  if (exam?.blueprint) return blueprintTotals(results, exam);
  if (exam?.optionalQuestions) return optionalTotals(results, exam);
  const effective = (r: QuestionResult) => r.teacherAdjustment?.marks ?? r.marks;
  const pendingQuestions = results.filter(r => effective(r) === null).map(r => r.identifier);
  const maximumMarks = round(results.reduce((s, r) => s + r.maximumMarks, 0));
  const gradedSubtotal = round(results.reduce((s, r) => s + (effective(r) ?? 0), 0));
  const proposals = results.map(r => effective(r) ?? r.provisionalMarks ?? null);
  // A missing award must not hide marks already assessed elsewhere. Null is
  // retained on the question; it is not converted to an assessed zero.
  const provisionalTotal = round(proposals.reduce<number>((sum, n) => sum + (n ?? 0), 0));
  return { maximumMarks, gradedSubtotal, totalMarks: pendingQuestions.length ? null : gradedSubtotal, percentage: pendingQuestions.length ? null : round(gradedSubtotal / maximumMarks * 100), pendingQuestions, provisionalTotal, provisionalPercentage: provisionalTotal === null ? null : round(provisionalTotal / maximumMarks * 100) };
}

