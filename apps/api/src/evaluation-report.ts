import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, type PDFPage, type RGB } from 'pdf-lib';
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

let fontBytes: Promise<Buffer[]> | undefined;
export async function createEvaluationReport(run: EvaluationRun, examName: string) {
  const report = reportContent(run, examName);
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  fontBytes ??= Promise.all(['Regular', 'Bold'].map(weight => readFile(new URL(`../src/report-assets/NotoSans-${weight}.ttf`, import.meta.url))));
  const [regularBytes, boldBytes] = await fontBytes;
  const font = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const safe = (s: string) => [...s.replace(/\t/g, '    ').replace(/\r/g, '').replace(/\u2212/g, '-')].map(c => c === '\n' || supported.has(c.codePointAt(0)!) ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`).join('');
  const navy = rgb(0.08, 0.18, 0.34), grey = rgb(0.35, 0.39, 0.46), ink = rgb(0.16, 0.20, 0.28);
  const pale = rgb(0.95, 0.96, 0.98), border = rgb(0.84, 0.87, 0.91), white = rgb(1, 1, 1), blue = rgb(0.20, 0.35, 0.62);
  const width = 595.28, height = 841.89, margin = 40, contentWidth = width - 2 * margin, bottom = 49;
  let page!: PDFPage;
  let y = 0, context = 'ASSESSMENT OVERVIEW';
  const newPage = () => {
    page = doc.addPage([width, height]); y = height - 100;
    page.drawRectangle({ x: 0, y: height - 57, width, height: 57, color: pale });
    page.drawText('Nergy Vidya', { x: margin, y: height - 32, font: bold, size: 16, color: navy });
    page.drawText('EVALUATION REPORT', { x: width - 172, y: height - 29, font: bold, size: 8, color: blue });
    let headerContext = safe(context);
    while (bold.widthOfTextAtSize(headerContext, 7.5) > contentWidth) headerContext = headerContext.slice(0, -2) + '…';
    page.drawText(headerContext, { x: margin, y: height - 68, font: bold, size: 7.5, color: grey });
    page.drawLine({ start: { x: margin, y: height - 46 }, end: { x: width - margin, y: height - 46 }, color: rgb(0.83, 0.85, 0.89), thickness: 0.7 });
  };
  newPage();
  const ensure = (space: number) => { if (y - space < bottom) newPage(); };
  const line = (s: string, size = 10, color = grey) => {
    ensure(size + 6); page.drawText(s, { x: margin, y, font: color === navy ? bold : font, size, color }); y -= size + 6;
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
  const wrap = (s: string, available: number, size = 8.3, face = font): string[] => {
    const lines: string[] = [];
    for (const original of safe(s).split('\n')) {
      let current = '';
      for (const word of original.split(/\s+/).filter(Boolean)) {
        if (current && face.widthOfTextAtSize(`${current} ${word}`, size) > available) { lines.push(current); current = ''; }
        if (face.widthOfTextAtSize(word, size) <= available) { current += (current ? ' ' : '') + word; continue; }
        for (const c of word) { if (face.widthOfTextAtSize(current + c, size) > available) { lines.push(current); current = ''; } current += c; }
      }
      lines.push(current);
    }
    return lines;
  };
  // Repeat headers and split oversized rows without dropping any cell content.
  const table = (headers: string[], fractions: number[], rows: string[][]) => {
    const widths = fractions.map(f => contentWidth * f), padding = 8, size = 8.3, leading = 12;
    const headerLines = headers.map((s, i) => wrap(s, widths[i] - padding * 2, 8, bold));
    const headerHeight = Math.max(...headerLines.map(l => l.length)) * 11 + padding * 2;
    const header = () => {
      page.drawRectangle({ x: margin, y: y - headerHeight, width: contentWidth, height: headerHeight, color: navy });
      let x = margin;
      headerLines.forEach((lines, i) => { lines.forEach((s, j) => page.drawText(s, { x: x + padding, y: y - padding - 8 - j * 11, font: bold, size: 8, color: white })); x += widths[i]; });
      y -= headerHeight;
    };
    ensure(headerHeight + 48); header();
    rows.forEach((row, index) => {
      const cells = headers.map((_, i) => wrap(row[i] ?? '', widths[i] - padding * 2));
      let offset = 0; const total = Math.max(...cells.map(c => c.length));
      while (offset < total) {
        if (y - bottom < padding * 2 + leading) { newPage(); header(); }
        const capacity = Math.floor((y - bottom - padding * 2) / leading);
        const count = Math.min(total - offset, Math.max(1, capacity)), rowHeight = count * leading + padding * 2;
        page.drawRectangle({ x: margin, y: y - rowHeight, width: contentWidth, height: rowHeight, color: index % 2 ? pale : white, borderColor: border, borderWidth: 0.5 });
        let x = margin;
        cells.forEach((lines, i) => {
          if (i) page.drawLine({ start: { x, y }, end: { x, y: y - rowHeight }, color: border, thickness: 0.5 });
          lines.slice(offset, offset + count).forEach((s, j) => page.drawText(s, { x: x + padding, y: y - padding - size - j * leading, font, size, color: ink }));
          x += widths[i];
        });
        y -= rowHeight; offset += count;
      }
    });
    y -= 18;
  };
  const feedback = (title: string, points: string[], tint: RGB, accent: RGB) => {
    if (!points.length) return;
    ensure(65); y -= 5;
    page.drawRectangle({ x: margin, y: y - 25, width: contentWidth, height: 25, color: tint });
    page.drawRectangle({ x: margin, y: y - 25, width: 3, height: 25, color: accent });
    page.drawText(title, { x: margin + 11, y: y - 17, font: bold, size: 9, color: accent }); y -= 40;
    for (const point of points) paragraph(`• ${point}`, 9);
  };
  paragraph(report.examName, 21, true);
  table(['STUDENT', 'EVALUATION DETAILS'], [0.45, 0.55], [[report.studentName, `Evaluated: ${new Date(report.evaluatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST\nSubmission: ${report.submissionId}`]]);
  ensure(105);
  page.drawRectangle({ x: margin, y: y - 94, width: contentWidth, height: 94, color: navy });
  page.drawText('OVERALL SCORE', { x: margin + 18, y: y - 22, font: bold, size: 8, color: rgb(0.74, 0.81, 0.93) });
  page.drawText(`${report.score} / ${report.maximumMarks}`, { x: margin + 18, y: y - 61, font: bold, size: 28, color: white });
  const right = margin + contentWidth * 0.58;
  page.drawText(report.provisional ? 'PROVISIONAL · REVIEW RECOMMENDED' : 'COMPLETED ASSESSMENT', { x: right, y: y - 25, font: bold, size: 7, color: white });
  page.drawText(`${Math.round(report.score / report.maximumMarks * 10000) / 100}%`, { x: right, y: y - 54, font: bold, size: 20, color: white });
  page.drawText(report.provisional ? 'Provisional awards are included.' : 'All assessed awards are included.', { x: right, y: y - 75, font, size: 8, color: white });
  y -= 112;
  paragraph('AI-assessed marks. Faculty-reviewed adjustments, where present, are shown separately.', 9);
  if (report.rawScore !== report.score) paragraph(`Calculated total: ${report.rawScore}. Displayed total follows the application rounding rule: below .5 down, above .5 up, exactly .5 unchanged. Question and criterion marks retain their precision.`, 9);
  if (report.sections.length) {
    heading('Section scores');
    table(['SECTION / COUNTED QUESTIONS', 'MARKS', 'STATUS'], [0.64, 0.16, 0.20], report.sections.map(s => [`${s.label}\nCounted: ${s.counted.join(', ') || 'None'}`, `${s.marks} / ${s.maximumMarks}`, s.provisional ? 'Provisional' : 'Assessed']));
  }
  heading('Questions at a glance');
  paragraph('Detailed rubric awards and feedback follow this summary. Optional alternatives are identified explicitly.', 8);
  table(['QUESTION', 'MAX.', 'AWARDED', 'ASSESSMENT', 'TOTAL'], [0.30, 0.10, 0.14, 0.26, 0.20], report.questions.map(q => [q.label, String(q.maximumMarks), mark(q.marks), q.adjustment ? 'Faculty reviewed' : q.provisional ? 'Provisional' : q.marks === null ? 'Needs review' : 'Assessed', q.counted ? 'Counted' : 'Not counted']));
  context = 'QUESTION-BY-QUESTION ASSESSMENT'; newPage();
  for (const q of report.questions) {
    context = `ASSESSMENT · ${q.label.toUpperCase()}`;
    ensure(155); y -= 6;
    const titleLines = wrap(q.label, contentWidth - 150, 13, bold);
    const bandHeight = Math.max(48, titleLines.length * 17 + 24);
    ensure(bandHeight + 80);
    page.drawRectangle({ x: margin, y: y - bandHeight, width: contentWidth, height: bandHeight, color: pale });
    titleLines.forEach((s, i) => page.drawText(s, { x: margin + 12, y: y - 23 - i * 17, font: bold, size: 13, color: navy }));
    page.drawText(`${mark(q.marks)} / ${q.maximumMarks}`, { x: width - margin - 133, y: y - 23, font: bold, size: 12, color: navy });
    page.drawText(q.adjustment ? 'FACULTY REVIEWED' : q.provisional ? 'PROVISIONAL' : q.marks === null ? 'NEEDS REVIEW' : 'ASSESSED', { x: width - margin - 133, y: y - 38, font: bold, size: 7, color: blue });
    y -= bandHeight + 17;
    paragraph(q.counted ? 'Counted towards the result.' : 'Optional alternative — not counted towards the result.', 9);
    paragraph(q.justification);
    if (q.adjustment) feedback('Faculty adjustment', [`Reviewed award: ${q.adjustment.marks}; original AI award: ${mark(q.adjustment.original)}. ${q.adjustment.reason}`], pale, blue);
    if (q.criteria.length) {
      ensure(155);
      heading('Rubric and marking breakdown');
      paragraph(q.criteria.some(c => c.inferred) ? 'AI-inferred allocations aligned with the supplied answer key; not teacher-approved.' : 'Mark allocations supplied in the answer key.', 9);
      table(['CRITERION / KEY BASIS', 'MAX.', 'AWARD', 'EVIDENCE / DEDUCTION'], [0.41, 0.09, 0.10, 0.40], q.criteria.map((c, i) => [
        [`${i + 1}. ${c.description || 'Criterion'}`, `Allocation: ${c.inferred ? 'AI-inferred' : 'Supplied'}`, c.expected ? `Expected: ${c.expected}` : '', c.keyBasis ? `Key basis: ${c.keyBasis}` : ''].filter(Boolean).join('\n\n'),
        String(c.maximumMarks), mark(c.marks), [c.evidence ? `Student evidence: ${c.evidence}` : '', c.reason ? `Award / deduction: ${c.reason}` : ''].filter(Boolean).join('\n\n'),
      ]));
    }
    feedback('Correct points', q.correct, pale, blue);
    feedback('Missing or incorrect', q.missing, rgb(0.99, 0.94, 0.93), rgb(0.62, 0.23, 0.20));
    feedback('Review recommendations', q.review.length ? q.review : q.provisional ? ['Review recommended before finalising this award.'] : [], rgb(1, 0.97, 0.88), rgb(0.55, 0.34, 0.05));
    y -= 12; ensure(10); page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: border, thickness: 0.6 }); y -= 15;
  }
  doc.getPages().forEach((p, i) => {
    p.drawLine({ start: { x: margin, y: 36 }, end: { x: width - margin, y: 36 }, color: border, thickness: 0.6 });
    p.drawText('Nergy Vidya · Evaluation report', { x: margin, y: 23, font, size: 7.5, color: grey });
    p.drawText(`${i + 1} / ${doc.getPageCount()}`, { x: width - margin - 40, y: 23, font: bold, size: 8, color: navy });
  });
  doc.setTitle(`${report.examName} — Evaluation report`); doc.setAuthor('Nergy Vidya');
  return Buffer.from(await doc.save());
}
