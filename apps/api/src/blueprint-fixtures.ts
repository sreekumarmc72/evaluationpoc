import type { BlueprintNode, ExamBlueprint, Exam } from '@poc/shared';
export function frBlueprint(): ExamBlueprint {
  const nodes: BlueprintNode[] = [];
  const node = (id: string, maximumMarks: number, kind: BlueprintNode['kind'], role: BlueprintNode['role'], children: string[] = [], requiredCount: number | null = null) => { nodes.push({ id, label: id, maximumMarks, kind, role, children, requiredCount, text: kind === 'score' ? `Printed ${id}: source question text` : '', instructions: kind === 'choose' ? `Answer any ${requiredCount} of ${children.length}` : 'All required parts', sourcePages: [1], marksSource: 'Printed marks and selection instruction', excessPolicy: 'highest_scores' }); };
  node('EXAM', 100, 'all', 'exam', ['I', 'II']);
  const mcqs = Array.from({ length: 23 }, (_, i) => `I-${i + 1}`); node('I', 30, 'all', 'section', mcqs);
  mcqs.forEach((id, i) => node(id, [7, 9, 16, 17, 18, 19, 20].includes(i + 1) ? 2 : 1, 'score', 'question'));
  node('II', 70, 'all', 'section', ['II-1', 'II-CHOICE']); node('II-1', 14, 'score', 'question');
  node('II-CHOICE', 56, 'choose', 'subpart', ['II-2', 'II-3', 'II-4', 'II-5', 'II-6'], 4);
  node('II-2', 14, 'all', 'question', ['II-2-a', 'II-2-b']); node('II-2-a', 10, 'score', 'subpart');
  node('II-2-b', 4, 'choose', 'subpart', ['II-2-b-Either', 'II-2-b-Or'], 1);
  node('II-2-b-Either', 4, 'score', 'alternative'); node('II-2-b-Or', 4, 'score', 'alternative');
  for (const [q, marks] of [[3, [8, 6]], [4, [8, 6]], [5, [7, 7]], [6, [5, 4, 5]]] as const) {
    const children = marks.map((_, i) => `II-${q}-${String.fromCharCode(97 + i)}`); node(`II-${q}`, 14, 'all', 'question', children);
    marks.forEach((m, i) => node(children[i], m, 'score', 'subpart'));
  }
  return { version: 2, rootId: 'EXAM', maximumMarks: 100, totalSource: 'Maximum Marks 100', nodes, issues: [], warnings: [] };
}
export function frExam(): Exam {
  const blueprint = frBlueprint(); const leaves = blueprint.nodes.filter(n => n.kind === 'score');
  return { blueprint, keyMappings: leaves.map(n => ({ identifier: n.id, expectedAnswer: 'Supplied key answer', markingCriteria: [], acceptedAlternatives: [], sourcePages: [1], evidence: `Key matches ${n.id}` })), policyVersion: null, selectionGroups: [], optionalQuestions: true, issues: [], warnings: [], marksEvidence: null, questions: leaves.map(n => ({ identifier: n.id, text: n.text, maximumMarks: n.maximumMarks, expectedAnswer: 'Supplied key answer', markingCriteria: [], acceptedAlternatives: [], gradingBasis: 'inferred', rubric: [{ id: 'R1', maximumMarks: n.maximumMarks, description: 'Correct requirement', expectedEvidence: 'Key answer', keyAlignment: 'Supplied key', allocationBasis: 'inferred' }] })) };
}
