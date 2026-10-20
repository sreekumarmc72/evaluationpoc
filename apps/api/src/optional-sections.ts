import { examMaximumMarks, type Exam, type QuestionResult, type Resolution, type Transcription, type Totals } from '@poc/shared';
import { AppError } from './errors.js';
function invalid(message: string): never { throw new AppError('UNSUPPORTED_EXAM', message); }
const round = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;
// Reading a figure is a grading concern; only mapping uncertainty can change
// whether a whole response is active or which optional alternative it belongs to.
const selectionUncertain = (answer: Transcription['answers'][number]) => answer.uncertainties.some(u => u.scope === 'mapping' && u.impact === 'potentially_score_changing');
const informationalFragment = (answer: Transcription['answers'][number]) => !answer.unsupportedContent && !answer.withdrawn && answer.uncertainties.length > 0 && answer.uncertainties.every(u => u.impact === 'non_material');
export function activeAnswers(transcription: Transcription, exam: Exam) {
  return exam.optionalQuestions ? transcription.answers.filter(a => !(a.withdrawn && a.withdrawalEvidence?.trim() && !selectionUncertain(a))) : transcription.answers;
}
export function validateSelectionRules(exam: Exam) {
  const groups = exam.selectionGroups ?? [];
  if (!exam.optionalQuestions) { if (groups.length) invalid('Compulsory exams cannot contain optional selection groups.'); return; }
  if (!groups.length) invalid('Optional questions require explicit, supported answer-any-N section rules.');
  if (!exam.marksEvidence?.printedTotal || !exam.marksEvidence.totalSource.trim()) invalid('Optional sections require an explicit printed exam maximum.');
  const seen = new Set<string>(); const ids = new Set<string>();
  for (const group of groups) {
    if (!group.id.trim() || ids.has(group.id) || !group.instructions.trim() || !group.sourcePages.length || group.requiredCount >= group.questionIds.length) invalid('Optional sections need unique IDs, explicit instructions, source pages and a valid answer count smaller than their available questions.');
    ids.add(group.id);
    const questions = group.questionIds.map(id => {
      const question = exam.questions.find(q => q.identifier === id);
      if (!question || seen.has(id)) return invalid('Optional sections must contain known questions exactly once, with no overlapping or nested choices.');
      seen.add(id); return question;
    });
    const unit = questions[0].maximumMarks;
    if (questions.some(q => q.maximumMarks !== unit) || Math.abs(group.maximumMarks - unit * group.requiredCount) > 0.000001) invalid('Only equal-mark answer-any-N sections with consistent section maxima are supported.');
    const evidence = exam.marksEvidence!.sections.find(section => section.identifier === group.id);
    if (!evidence || evidence.questions.length !== group.questionIds.length || evidence.questions.some(q => !group.questionIds.includes(q.identifier))) invalid('Optional section membership must match the printed section evidence.');
    if (evidence.headingScope !== 'per_question' && evidence.headingScope !== 'section_total') invalid('Optional sections need unambiguous each-question marks or an explicit section allocation formula.');
    if (group.excessPolicy === 'first_in_script' && !group.excessInstructions.trim()) invalid('Counting the first answers requires an explicit printed instruction.');
    if (group.excessPolicy === 'review' && group.excessInstructions.trim()) invalid('A printed excess-answer instruction needs a supported explicit policy; do not ignore it.');
  }
}
export function applyOptionalSelection(results: QuestionResult[], exam: Exam, transcription: Transcription, resolution: Resolution) {
  if (!exam.optionalQuestions) return results;
  for (const result of results) { result.selectionStatus = 'counted'; delete result.selectionNote; }
  const activeIds = new Set(activeAnswers(transcription, exam).map(a => a.entryId));
  const withdrawn = new Set(transcription.answers.filter(a => !activeIds.has(a.entryId)).map(a => a.entryId));
  for (const group of exam.selectionGroups!) {
    const mappings = resolution.mappings.filter(m => !withdrawn.has(m.entryId));
    const attempted = group.questionIds.filter(id => mappings.some(m => m.questionId === id));
    const reasons: string[] = [];
    // Incomplete coverage makes the award provisional (grading retains that
    // flag), but does not discard marks for the visible, established attempts.
    for (const mapping of mappings) {
      const answer = transcription.answers.find(a => a.entryId === mapping.entryId)!;
      const relevant = mapping.questionId ? group.questionIds.includes(mapping.questionId) : !mapping.candidateQuestionIds.length || mapping.candidateQuestionIds.some(id => group.questionIds.includes(id));
      if (!relevant) continue;
      if (selectionUncertain(answer)) reasons.push(`Entry ${mapping.entryId} has unresolved question-association or whole-answer cancellation evidence.`);
      if (mapping.questionId === null && !informationalFragment(answer)) {
        // A continuation of an already attempted question can affect its grade,
        // but cannot introduce a competing optional alternative.
        const couldAddAlternative = !mapping.candidateQuestionIds.length || mapping.candidateQuestionIds.some(id => group.questionIds.includes(id) && !attempted.includes(id));
        if (couldAddAlternative) reasons.push(`Unmapped entry ${mapping.entryId} could be an additional answer${mapping.candidateQuestionIds.length ? ` (${mapping.candidateQuestionIds.join(', ')})` : ' with no established question candidates'}.`);
      }
    }
    const ambiguous = reasons.length > 0;
    const over = attempted.length > group.requiredCount;
    const pending = ambiguous || (over && group.excessPolicy === 'review');
    // Page order takes precedence; preserved entry order breaks ties on a page.
    const order = (id: string) => Math.min(...transcription.answers.map((a, index) => !withdrawn.has(a.entryId) && mappings.some(m => m.entryId === a.entryId && m.questionId === id) ? Math.min(...a.sourcePages) * (transcription.answers.length + 1) + index : Infinity));
    const counted = pending ? [] : over ? [...attempted].sort((a, b) => order(a) - order(b)).slice(0, group.requiredCount) : attempted;
    for (const result of results.filter(r => group.questionIds.includes(r.identifier))) {
      result.selectionStatus = pending ? 'pending_selection' : counted.includes(result.identifier) ? 'counted' : 'not_selected';
      result.selectionNote = pending ? ambiguous ? [...new Set(reasons)].join(' ') : `More than ${group.requiredCount} answers were attempted without a printed rule choosing which count. No highest-score or first-answer policy was assumed.` : result.selectionStatus === 'counted' ? !transcription.allPagesRead ? 'Counted toward the provisional total from the visible answers. Incomplete page coverage still requires review.' : 'Counted toward this section.' : 'Optional alternative not selected — no deduction for this question.';
      if (result.selectionStatus === 'not_selected' && result.status === 'unattempted') { result.missingPoints = []; result.justification = result.selectionNote; }
    }
  }
  return results;
}
export function optionalTotals(results: QuestionResult[], exam: Exam): Totals {
  const effective = (r: QuestionResult) => r.teacherAdjustment?.marks ?? r.marks;
  if (results.length !== exam.questions.length || results.some(r => !r.selectionStatus)) return invalid('Optional totals require validated selection for every question.');
  const sectionResults = exam.selectionGroups!.map(group => {
    const members = results.filter(r => group.questionIds.includes(r.identifier));
    const counted = members.filter(r => r.selectionStatus === 'counted');
    if (counted.length > group.requiredCount) return invalid('An optional section cannot count more answers than its printed limit.');
    const pending = members.filter(r => r.selectionStatus === 'pending_selection');
    const subtotal = round(counted.reduce((sum, r) => sum + (effective(r) ?? 0), 0));
    const proposals = counted.map(r => effective(r) ?? r.provisionalMarks ?? null);
    return { sectionId: group.id, instructions: group.instructions, requiredCount: group.requiredCount, maximumMarks: group.maximumMarks,
      countedQuestionIds: counted.map(r => r.identifier), notSelectedQuestionIds: members.filter(r => r.selectionStatus === 'not_selected').map(r => r.identifier),
      pendingQuestionIds: members.filter(r => r.selectionStatus === 'pending_selection' || (r.selectionStatus === 'counted' && effective(r) === null)).map(r => r.identifier),
      gradedSubtotal: subtotal, totalMarks: pending.length || counted.some(r => effective(r) === null) ? null : subtotal,
      provisionalTotal: pending.length || proposals.some(n => n === null) ? null : round(proposals.reduce<number>((sum, n) => sum + n!, 0)),
      reviewFlags: [...new Set(pending.map(r => r.selectionNote ?? 'Section selection needs review.'))],
      notes: !pending.length && counted.length < group.requiredCount ? [`${counted.length} of ${group.requiredCount} required answers attempted; missing answer slots receive no marks. The section maximum remains ${group.maximumMarks}.`] : group.excessPolicy === 'first_in_script' ? ['Where excess answers occur, the printed first-in-script rule determines the counted answers.'] : [],
    };
  });
  const counted = results.filter(r => r.selectionStatus === 'counted');
  const pendingQuestions = results.filter(r => r.selectionStatus === 'pending_selection' || (r.selectionStatus === 'counted' && effective(r) === null)).map(r => r.identifier);
  const maximumMarks = round(examMaximumMarks(exam));
  const gradedSubtotal = round(counted.reduce((sum, r) => sum + (effective(r) ?? 0), 0));
  const proposals = counted.map(r => effective(r) ?? r.provisionalMarks ?? null);
  const provisionalTotal = results.some(r => r.selectionStatus === 'pending_selection') || proposals.some(n => n === null) ? null : round(proposals.reduce<number>((sum, n) => sum + n!, 0));
  return { maximumMarks, gradedSubtotal, totalMarks: pendingQuestions.length ? null : gradedSubtotal, percentage: pendingQuestions.length ? null : round(gradedSubtotal / maximumMarks * 100), pendingQuestions, provisionalTotal, provisionalPercentage: provisionalTotal === null ? null : round(provisionalTotal / maximumMarks * 100), sectionResults };
}
