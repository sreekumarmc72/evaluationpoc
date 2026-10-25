import type { Exam, Totals, ExamBlueprint } from '@poc/shared';

export function BlueprintView({ blueprint }: { blueprint: ExamBlueprint }) {
  return <section aria-label="Exam blueprint"><h3>Exam structure · {blueprint.maximumMarks} marks</h3><p className="muted">Subparts are combined before parent-question selection. Only the selected alternative contributes.</p>{blueprint.nodes.filter(n => n.kind !== 'score').map(n => <details key={n.id}><summary>{n.label} · {n.maximumMarks} marks · {n.kind === 'choose' ? `choose ${n.requiredCount} of ${n.children.length}` : 'combine required parts'}</summary><p>{n.instructions}</p><ul>{n.children.map(id => { const child = blueprint!.nodes.find(n => n.id === id)!; return <li key={id}>{child.label} · {child.maximumMarks} marks</li>; })}</ul><p className="muted">Paper pages {n.sourcePages.join(', ')} · {n.marksSource}</p></details>)}</section>;
}
export function ExamSelectionRules({ exam }: { exam: Exam }) {
  if (exam.blueprint) return <BlueprintView blueprint={exam.blueprint} />;
  if (!exam.optionalQuestions) return null;
  return <section aria-label="Optional section instructions"><h3>Answer selection</h3>{exam.selectionGroups?.map(group => <p key={group.id}><strong>Section {group.id}:</strong> {group.instructions} · {group.questionIds.length} available, {group.requiredCount} required · {group.maximumMarks} marks{group.excessPolicy === 'first_in_script' ? ` · ${group.excessInstructions}` : ''}</p>)}</section>;
}
export function SectionScores({ totals }: { totals: Totals }) {
  if (!totals.sectionResults?.length && !totals.blueprintResults?.length) return null;
  return <section aria-label="Section scores"><h2>Section scores & counted answers</h2>{totals.blueprintResults && <details><summary>Parent questions & internal choices</summary>{totals.blueprintResults.filter(n => n.kind !== 'score').map(n => <p key={n.nodeId}><strong>{n.label}</strong>: {n.marks} / {n.maximumMarks}{n.counted ? n.provisional ? ' · Provisional' : ' · Counted' : ' · Not selected'}{n.kind === 'choose' && ` · Selected: ${n.selectedChildren.join(', ') || 'none established'}`}</p>)}</details>}{totals.sectionResults?.map(section => <article className="question" key={section.sectionId}>
    <div className="question-top"><h3>{/^(section|part)\b/i.test(section.sectionId) ? section.sectionId : `Section ${section.sectionId}`}</h3><span className={`mark ${section.totalMarks === null ? 'review' : ''}`}>{section.totalMarks !== null ? `${section.totalMarks} / ${section.maximumMarks}` : section.provisionalTotal !== null ? `${section.provisionalTotal} / ${section.maximumMarks} · Provisional` : `Subtotal ${section.gradedSubtotal} / ${section.maximumMarks} · Review required`}</span></div>
    <p className="muted">{section.instructions}</p><p className="muted">Counted: {section.countedQuestionIds.join(', ') || 'None confirmed'} · Required: {section.requiredCount} answers.</p>
    {!!section.notSelectedQuestionIds.length && <p className="muted">Not selected: {section.notSelectedQuestionIds.join(', ')}. No deduction for optional alternatives.</p>}
    {!!section.pendingQuestionIds.length && <p className="muted">Pending review: {section.pendingQuestionIds.join(', ')}.</p>}
    {section.notes.map(note => <p className="muted" key={note}>{note}</p>)}
    {!!section.reviewFlags.length && <div className="notice"><strong>Selection review required</strong><ul>{section.reviewFlags.map(flag => <li key={flag}>{flag}</li>)}</ul></div>}
  </article>)}</section>;
}
