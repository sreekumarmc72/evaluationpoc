import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { displayedTotals, type EvaluationRun } from '@poc/shared';
import { AppError } from './errors.js';

// The report is an allowlisted view of the saved evaluation, never a copy of
// the run object. Processing warnings, readings, mappings and source IDs stay private.
const technical = /transcrib|handwrit|\bunnumbered\b|\bunmapped\b|\bmapping\b|question.association|unresolved association|unassigned (?:answer|content|fragment)|no (?:written )?answers? (?:were |was )?found|page coverage|pages? (?:could|were|was|not|inspected|read)|source (?:entry|block|quote|reference)|entry-\d|page-\d|\b(?:API|tokens?|SDK|timeout|checkpoint|model call|READING_QUALITY)\b|\[illegible\]|\b(?:unreadable|illegible|cropped|clipped)\b|reading (?:note|uncertainty|ambiguity|recovery)|visible (?:label|identifier)/i;
export function evaluationFeedback(value: string): string {
  return value.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s && !technical.test(s) && !/\bmapped (?:response|answer|content|fragment)\b|answer content (?:was |is )?(?:not )?mapped/i.test(s)).join(' ');
}
export function reportContent(run: EvaluationRun, examName: string) {
  if (run.stage !== 'completed' || !run.exam || !run.totals) throw new AppError('REPORT_NOT_READY', 'A PDF report is available after evaluation is completed.', 409);
  const totals = displayedTotals(run.totals);
  const raw = run.totals.totalMarks ?? run.totals.provisionalTotal ?? run.totals.gradedSubtotal;
  const score = totals.totalMarks ?? totals.provisionalTotal ?? totals.gradedSubtotal;
  const provisional = totals.totalMarks === null;
  const identity = run.transcription?.studentIdentity;
  return {
    examName, studentName: run.manualStudentName?.name ?? (identity?.status === 'readable' ? identity.name : null) ?? 'Student',
    submissionId: run.id, evaluatedAt: run.finishedAt ?? run.createdAt,
    score, rawScore: raw, maximumMarks: totals.maximumMarks, provisional,
    sections: (run.totals.sectionResults ?? []).map(s => ({
      label: run.exam!.blueprint?.nodes.find(n => n.id === s.sectionId)?.label ?? s.sectionId,
      marks: s.totalMarks ?? s.provisionalTotal ?? s.gradedSubtotal, maximumMarks: s.maximumMarks,
      provisional: s.totalMarks === null, counted: s.countedQuestionIds,
    })),
    questions: run.results.map(r => {
      const q = run.exam!.questions.find(q => q.identifier === r.identifier);
      return {
        label: run.exam!.blueprint?.nodes.find(n => n.id === r.identifier)?.label ?? `Question ${r.identifier}`,
        marks: r.teacherAdjustment?.marks ?? r.marks ?? r.provisionalMarks ?? null,
        maximumMarks: r.maximumMarks, counted: r.selectionStatus !== 'not_selected',
        provisional: !r.teacherAdjustment && (r.status === 'needs_review' || r.selectionStatus === 'pending_selection'),
        justification: evaluationFeedback(r.justification),
        correct: r.correctPoints.map(evaluationFeedback).filter(Boolean), missing: r.missingPoints.map(evaluationFeedback).filter(Boolean),
        review: r.reviewFlags.map(evaluationFeedback).filter(Boolean),
        adjustment: r.teacherAdjustment ? { marks: r.teacherAdjustment.marks, reason: evaluationFeedback(r.teacherAdjustment.reason), original: r.marks ?? r.provisionalMarks ?? null } : null,
        criteria: (q?.rubric ?? []).map(c => {
          const award = r.criterionAwards?.find(a => a.criterionId === c.id);
          return { description: evaluationFeedback(c.description), expected: evaluationFeedback(c.expectedEvidence), keyBasis: evaluationFeedback(c.keyAlignment), inferred: c.allocationBasis === 'inferred', maximumMarks: c.maximumMarks,
            marks: award?.marks ?? null, evidence: evaluationFeedback(award?.evidence ?? ''), reason: evaluationFeedback(award?.reason ?? '') };
        }),
      };
    }),
  };
}

let fontBytes: Promise<Buffer> | undefined;
export async function createEvaluationReport(run: EvaluationRun, examName: string) {
  const report = reportContent(run, examName);
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  fontBytes ??= readFile(new URL('../src/report-assets/NotoSans-Regular.ttf', import.meta.url));
  const font = await doc.embedFont(await fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const safe = (s: string) => [...s.replace(/\t/g, '    ').replace(/\r/g, '').replace(/\u2212/g, '-')].map(c => c === '\n' || supported.has(c.codePointAt(0)!) ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`).join('');
  const navy = rgb(0.08, 0.18, 0.34), grey = rgb(0.35, 0.39, 0.46);
  const width = 595.28, height = 841.89, margin = 46, contentWidth = width - 2 * margin;
  let page: PDFPage, y = 0;
  const newPage = () => {
    page = doc.addPage([width, height]); y = height - 73;
    page.drawText('Nergy Vidya', { x: margin, y: height - 35, font, size: 14, color: navy });
    page.drawText('EVALUATION REPORT', { x: width - 184, y: height - 34, font, size: 9, color: grey });
    page.drawLine({ start: { x: margin, y: height - 46 }, end: { x: width - margin, y: height - 46 }, color: rgb(0.83, 0.85, 0.89), thickness: 0.7 });
  };
  newPage();
  const ensure = (space: number) => { if (y - space < 50) newPage(); };
  const line = (s: string, size = 10, color = grey) => {
    ensure(size + 6); page.drawText(s, { x: margin, y, font, size, color }); y -= size + 6;
  };
  const paragraph = (s: string, size = 10, heading = false) => {
    if (!s) return;
    for (const original of safe(s).split('\n')) {
      let current = '';
      for (const word of original.split(/\s+/)) {
        if (!word) continue;
        if (current && font.widthOfTextAtSize(`${current} ${word}`, size) > contentWidth) { line(current, size, heading ? navy : grey); current = ''; }
        if (font.widthOfTextAtSize(word, size) <= contentWidth) { current += (current ? ' ' : '') + word; continue; }
        // Split long formula/URL tokens rather than drawing beyond the margin.
        for (const c of (current ? ` ${word}` : word)) {
          if (font.widthOfTextAtSize(current + c, size) > contentWidth) { line(current, size, heading ? navy : grey); current = ''; }
          current += c;
        }
      }
      if (current) line(current, size, heading ? navy : grey);
    }
    y -= heading ? 6 : 4;
  };
  const heading = (s: string) => { ensure(65); paragraph(s, 13, true); };
  const mark = (n: number | null) => n === null ? 'Not assessed' : String(n);
  paragraph(report.examName, 18, true);
  paragraph(`Student: ${report.studentName}`);
  paragraph(`Submission: ${report.submissionId}`, 9);
  paragraph(`Evaluated: ${new Date(report.evaluatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST`, 9);
  heading(`${report.score} / ${report.maximumMarks}${report.provisional ? ' · Provisional' : ''}`);
  if (report.provisional) paragraph('Review recommended. Provisional awards are included in the marks shown.');
  paragraph('AI-assessed marks. Faculty-reviewed adjustments, where present, are shown separately.', 9);
  if (report.rawScore !== report.score) paragraph(`Calculated total: ${report.rawScore}. Displayed total follows the application rounding rule: below .5 down, above .5 up, exactly .5 unchanged. Question and criterion marks retain their precision.`, 9);
  if (report.sections.length) {
    heading('Section scores');
    for (const section of report.sections) {
      paragraph(`${section.label}: ${section.marks} / ${section.maximumMarks}${section.provisional ? ' · Provisional' : ''}`, 11, true);
      paragraph(`Counted questions: ${section.counted.join(', ') || 'None'}`, 9);
    }
  }
  for (const q of report.questions) {
    y -= 10; heading(`${q.label} · ${mark(q.marks)} / ${q.maximumMarks}${q.provisional ? ' · Provisional' : ''}`);
    paragraph(q.counted ? 'Counted towards the result.' : 'Optional alternative — not counted towards the result.', 9);
    paragraph(q.justification);
    if (q.adjustment) paragraph(`Faculty adjustment: ${q.adjustment.marks}; original AI award: ${mark(q.adjustment.original)}. ${q.adjustment.reason}`);
    if (q.criteria.length) {
      heading('Marking rubric and awards');
      paragraph(q.criteria.some(c => c.inferred) ? 'AI-inferred allocations aligned with the supplied answer key; not teacher-approved.' : 'Mark allocations supplied in the answer key.', 9);
      for (const c of q.criteria) {
        ensure(65); paragraph(`${c.description || 'Criterion'} · ${mark(c.marks)} / ${c.maximumMarks}`, 10, true);
        paragraph(`Allocation: ${c.inferred ? 'AI-inferred' : 'Supplied'}`, 9);
        if (c.expected) paragraph(`Expected: ${c.expected}`, 9);
        if (c.keyBasis) paragraph(`Key basis: ${c.keyBasis}`, 9);
        if (c.evidence) paragraph(`Student evidence: ${c.evidence}`, 9);
        if (c.reason) paragraph(`Award / deduction: ${c.reason}`, 9);
      }
    }
    for (const [title, points] of [['Correct points', q.correct], ['Missing or incorrect', q.missing], ['Review recommendations', q.review]] as const) {
      if (points.length) { heading(title); for (const point of points) paragraph(`• ${point}`); }
    }
    if (q.provisional && !q.review.length) paragraph('Review recommended before finalising this award.', 9);
  }
  doc.getPages().forEach((p, i) => p.drawText(`Nergy Vidya · ${i + 1} / ${doc.getPageCount()}`, { x: margin, y: 25, font, size: 8, color: grey }));
  doc.setTitle(`${report.examName} — Evaluation report`); doc.setAuthor('Nergy Vidya');
  return Buffer.from(await doc.save());
}
