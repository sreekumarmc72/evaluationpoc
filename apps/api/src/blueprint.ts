import { BlueprintSchema, type ExamBlueprint, type BlueprintNode, type Exam, type QuestionResult, type Transcription, type Resolution, type Totals } from '@poc/shared';
import { AppError } from './errors.js';
const fail = (message: string): never => { throw new AppError('BLUEPRINT_ISSUES', message); };
const near = (a: number, b: number) => Math.abs(a - b) < 0.000001;
export function validateBlueprint(value: unknown, pageCount?: number): ExamBlueprint {
  const parsed = BlueprintSchema.safeParse(value); if (!parsed.success) return fail('Invalid exam blueprint structure.');
  const b = parsed.data; if (b.issues.length) return fail(b.issues.join('; '));
  const nodes = new Map(b.nodes.map(n => [n.id, n]));
  if (nodes.size !== b.nodes.length || !b.totalSource.trim()) return fail('Blueprint IDs must be unique and the printed maximum needs evidence.');
  const visited = new Set<string>(); const visiting = new Set<string>();
  function walk(id: string, depth: number, choices: number): number {
    const n = nodes.get(id); if (!n || visited.has(id) || visiting.has(id) || depth > 10) return fail(`Blueprint node ${id}: unknown, overlapping, cyclic or excessively nested reference.`);
    visiting.add(id);
    if (!n.id.trim() || !n.label.trim() || !n.sourcePages.length || new Set(n.sourcePages).size !== n.sourcePages.length || n.sourcePages.some(p => pageCount !== undefined && p > pageCount) || !n.marksSource.trim()) return fail(`Blueprint node ${id} needs labels, valid source pages and mark evidence.`);
    if (n.kind === 'score') {
      if (n.children.length || n.requiredCount !== null || !n.text.trim() || ['exam', 'section'].includes(n.role)) return fail(`Scored node ${id} must be a text-bearing leaf, with no children or quota.`);
    } else {
      if (!n.children.length || new Set(n.children).size !== n.children.length) return fail(`Blueprint node ${id} needs distinct children.`);
      const nextChoices = choices + (n.kind === 'choose' ? 1 : 0);
      if (nextChoices > 2) return fail(`Choice ${id}: only whole-question selection with one internal alternative level is supported.`);
      const marks = n.children.map(child => walk(child, depth + 1, nextChoices));
      if (n.kind === 'choose') {
        if (!n.requiredCount || n.requiredCount >= marks.length || !n.instructions.trim() || marks.some(m => !near(m, marks[0]))) return fail(`Choice ${id} needs an explicit quota and equal-mark alternatives.`);
        if (!near(n.maximumMarks, marks[0] * n.requiredCount)) return fail(`Choice ${id} maximum does not match its quota.`);
        if (n.excessPolicy === 'first_in_script' && !/first|order/i.test(n.instructions)) return fail(`Choice ${id} lacks printed first-answer evidence.`);
      } else if (n.requiredCount !== null || !near(n.maximumMarks, marks.reduce((a, c) => a + c, 0))) return fail(`Combined node ${id} total differs from its children.`);
    }
    visiting.delete(id); visited.add(id); return n.maximumMarks;
  }
  const root = nodes.get(b.rootId);
  if (!root || root.role !== 'exam' || root.kind !== 'all' || !near(walk(b.rootId, 0, 0), b.maximumMarks) || visited.size !== nodes.size) return fail('Blueprint root, total or node coverage is inconsistent.');
  return b;
}
export function validateBlueprintExam(exam: Exam) {
  const b = validateBlueprint(exam.blueprint); const leaves = b.nodes.filter(n => n.kind === 'score');
  if (exam.selectionGroups?.length || exam.optionalQuestions !== b.nodes.some(n => n.kind === 'choose')) return fail('Blueprint selection rules cannot be mixed with legacy groups or inconsistent optional flags.');
  if (leaves.length !== exam.questions.length || leaves.some(n => !exam.questions.some(q => q.identifier === n.id && near(q.maximumMarks, n.maximumMarks) && q.text === n.text))) return fail('Scored questions must match every blueprint leaf exactly.');
  if (exam.keyMappings) {
    if (exam.keyMappings.length !== leaves.length || new Set(exam.keyMappings.map(k => k.identifier)).size !== leaves.length || exam.keyMappings.some(k => !leaves.some(n => n.id === k.identifier) || !k.expectedAnswer.trim() || !k.evidence.trim() || !k.sourcePages.length)) return fail('Every blueprint leaf needs a unique, evidenced key mapping.');
  } else return fail('A version 2 exam needs answer-key mappings.');
  if (exam.questions.some(q => q.expectedAnswer !== exam.keyMappings!.find(k => k.identifier === q.identifier)?.expectedAnswer)) return fail('Expected answers must retain their mapped answer-key text.');
}
export function blueprintTotals(results: QuestionResult[], exam: Exam, t?: Transcription, resolution?: Resolution): Totals {
  const b = exam.blueprint!; const nodes = new Map(b.nodes.map(n => [n.id, n])); const byId = new Map(results.map(r => [r.identifier, r]));
  if (results.length !== exam.questions.length || byId.size !== results.length || exam.questions.some(q => !byId.has(q.identifier))) return fail('Blueprint totals require every scored unit exactly once.');
  const effective = (r: QuestionResult) => r.teacherAdjustment?.marks ?? r.marks ?? r.provisionalMarks ?? 0;
  // Teacher adjustments retain persisted attempt/ordering evidence; they never
  // turn a blank alternative into an attempted answer.
  const active = (t?.answers ?? []).filter(a => !(a.withdrawn && a.withdrawalEvidence?.trim() && !a.uncertainties.some(u => u.scope === 'mapping' && u.impact === 'potentially_score_changing')));
  const materialEntries = active.filter(a => a.unsupportedContent || a.withdrawn || !a.uncertainties.length || a.uncertainties.some(u => u.impact !== 'non_material'));
  const source = (id: string) => active.filter(a => resolution?.mappings.some(m => m.entryId === a.entryId && m.questionId === id));
  type State = { node: BlueprintNode; marks: number; attempted: boolean; order: number; provisional: boolean; selected: string[]; flags: string[] };
  const states = new Map<string, State>();
  function score(id: string): State {
    const n = nodes.get(id)!;
    let s: State;
    if (n.kind === 'score') {
      const r = byId.get(id)!; const entries = source(id);
      const attempted = t ? entries.length > 0 : r.attemptEstablished ?? r.status !== 'unattempted';
      const ambiguous = t ? !t.allPagesRead || materialEntries.some(a => a.uncertainties.some(u => u.scope === 'mapping' && u.impact === 'potentially_score_changing') && resolution?.mappings.some(m => m.entryId === a.entryId && (m.questionId === id || m.questionId === null && (!m.candidateQuestionIds.length || m.candidateQuestionIds.includes(id))))) || materialEntries.some(a => resolution?.mappings.some(m => m.entryId === a.entryId && m.questionId === null && (!m.candidateQuestionIds.length || m.candidateQuestionIds.includes(id)))) : r.selectionUncertain === true;
      const order = entries.length ? Math.min(...entries.map(a => Math.min(...a.sourcePages) * (active.length + 1) + active.indexOf(a))) : Number(r.selectionOrder ?? Infinity);
      s = { node: n, marks: attempted ? effective(r) : 0, attempted, order, provisional: ambiguous || attempted && (!r.teacherAdjustment && (r.marks === null || r.reviewFlags.length > 0)), selected: [], flags: ambiguous ? ['Selection uses established visible answers; unresolved mapping or coverage requires review.'] : [] };
      if (t) { r.selectionOrder = Number.isFinite(order) ? order : null; r.attemptEstablished = attempted; r.selectionUncertain = ambiguous; }
    } else {
      const children = n.children.map(score); let selected = children;
      if (n.kind === 'choose') selected = children.filter(c => c.attempted).sort((a, c) => n.excessPolicy === 'first_in_script' ? a.order - c.order || n.children.indexOf(a.node.id) - n.children.indexOf(c.node.id) : c.marks - a.marks || a.order - c.order || n.children.indexOf(a.node.id) - n.children.indexOf(c.node.id)).slice(0, n.requiredCount!);
      s = { node: n, marks: selected.reduce((sum, c) => sum + c.marks, 0), attempted: children.some(c => c.attempted), order: Math.min(...children.map(c => c.order)), provisional: selected.some(c => c.provisional) || children.some(c => c.flags.length > 0), selected: selected.map(c => c.node.id), flags: [...new Set(children.flatMap(c => c.flags))] };
    }
    states.set(id, s); return s;
  }
  const root = score(b.rootId); const counted = new Set<string>();
  function select(id: string) { counted.add(id); for (const child of states.get(id)!.selected) select(child); }
  select(b.rootId);
  for (const r of results) { r.selectionStatus = counted.has(r.identifier) ? 'counted' : 'not_selected'; r.selectionNote = states.get(r.identifier)!.attempted ? counted.has(r.identifier) ? 'Counted through its parent question and applicable choice rules.' : 'Not selected under the parent-question or internal-alternative quota.' : 'Blueprint: no established attempt.'; }
  const pendingQuestions = [...results.filter(r => counted.has(r.identifier) && states.get(r.identifier)!.provisional).map(r => r.identifier), ...b.nodes.filter(n => n.kind === 'choose' && counted.has(n.id) && states.get(n.id)!.flags.length).map(n => n.id)];
  const provisional = root.provisional; const round = (v: number) => Math.round(v * 10000) / 10000;
  const finalSubtotal = results.filter(r => counted.has(r.identifier)).reduce((sum, r) => sum + (r.teacherAdjustment?.marks ?? r.marks ?? 0), 0);
  const finalWithin = (id: string): number => { const s = states.get(id)!; return s.node.kind === 'score' ? byId.get(id)!.teacherAdjustment?.marks ?? byId.get(id)!.marks ?? 0 : s.selected.reduce((sum, child) => sum + finalWithin(child), 0); };
  const sectionQuestions = (id: string, selectedOnly: boolean): string[] => { const s = states.get(id)!; if (s.node.role === 'question' || s.node.kind === 'score') return [id]; return (selectedOnly ? s.selected : s.node.children).flatMap(child => sectionQuestions(child, selectedOnly)); };
  const questionQuota = (id: string): number => { const n = nodes.get(id)!; if (n.role === 'question' || n.kind === 'score') return 1; return n.kind === 'choose' ? n.requiredCount! * questionQuota(n.children[0]) : n.children.reduce((sum, child) => sum + questionQuota(child), 0); };
  const topSections = (id: string): BlueprintNode[] => { const n = nodes.get(id)!; return n.role === 'section' ? [n] : n.children.flatMap(topSections); };
  return { maximumMarks: b.maximumMarks, gradedSubtotal: round(finalSubtotal), totalMarks: provisional ? null : round(root.marks), percentage: provisional ? null : round(root.marks / b.maximumMarks * 100), pendingQuestions, provisionalTotal: round(root.marks), provisionalPercentage: round(root.marks / b.maximumMarks * 100),
    blueprintResults: [...states.values()].map(s => ({ nodeId: s.node.id, label: s.node.label, kind: s.node.kind, maximumMarks: s.node.maximumMarks, marks: round(s.marks), provisional: s.provisional, counted: counted.has(s.node.id), selectedChildren: s.selected, reviewFlags: s.flags })),
    sectionResults: topSections(b.rootId).map(n => { const s = states.get(n.id)!; const selected = n.children.flatMap(child => sectionQuestions(child, true)); const available = n.children.flatMap(child => sectionQuestions(child, false)); return { sectionId: n.label, instructions: n.instructions, requiredCount: questionQuota(n.id), maximumMarks: n.maximumMarks, countedQuestionIds: selected, notSelectedQuestionIds: available.filter(id => !selected.includes(id)), pendingQuestionIds: selected.filter(id => states.get(id)!.provisional), gradedSubtotal: round(finalWithin(n.id)), totalMarks: s.provisional ? null : round(s.marks), provisionalTotal: round(s.marks), reviewFlags: s.flags, notes: [] }; }) };
}
