import type { Exam, Totals } from '@poc/shared';

export function ExamSelectionRules({ exam }: { exam: Exam }) {
  if (!exam.optionalQuestions) return null;
  return <section aria-label="Optional section instructions"><h3>Answer selection</h3>{exam.selectionGroups?.map(group => <p key={group.id}><strong>Section {group.id}:</strong> {group.instructions} · {group.questionIds.length} available, {group.requiredCount} required · {group.maximumMarks} marks{group.excessPolicy === 'first_in_script' ? ` · ${group.excessInstructions}` : ''}</p>)}</section>;
}
export function SectionScores({ totals }: { totals: Totals }) {
  if (!totals.sectionResults?.length) return null;
  return <section aria-label="Section scores"><h2>Section scores & counted answers</h2>{totals.sectionResults.map(section => <article className="question" key={section.sectionId}>
    <div className="question-top"><h3>Section {section.sectionId}</h3><span className={`mark ${section.totalMarks === null ? 'review' : ''}`}>{section.totalMarks !== null ? `${section.totalMarks} / ${section.maximumMarks}` : section.provisionalTotal !== null ? `${section.provisionalTotal} / ${section.maximumMarks} · Provisional` : `Subtotal ${section.gradedSubtotal} / ${section.maximumMarks} · Review required`}</span></div>
    <p className="muted">{section.instructions}</p><p className="muted">Counted: {section.countedQuestionIds.join(', ') || 'None confirmed'} · Required: {section.requiredCount} answers.</p>
    {!!section.notSelectedQuestionIds.length && <p className="muted">Not selected: {section.notSelectedQuestionIds.join(', ')}. No deduction for optional alternatives.</p>}
    {!!section.pendingQuestionIds.length && <p className="muted">Pending review: {section.pendingQuestionIds.join(', ')}.</p>}
    {section.notes.map(note => <p className="muted" key={note}>{note}</p>)}
    {!!section.reviewFlags.length && <div className="notice"><strong>Selection review required</strong><ul>{section.reviewFlags.map(flag => <li key={flag}>{flag}</li>)}</ul></div>}
  </article>)}</section>;
}
