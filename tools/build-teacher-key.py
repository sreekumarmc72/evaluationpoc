from pathlib import Path
import json
from html import escape
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/answer-key'
policy = json.loads((ROOT / 'docs/marking-policy-v1.json').read_text())
doc = Document(OUT / 'Accounting Test Solutions Reviewed.docx')
# Edit the actual Q1 narration, including text inside tables, preserving runs.
def paragraphs(document):
    yield from document.paragraphs
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from cell.paragraphs
for paragraph in paragraphs(doc):
    for run in paragraph.runs:
        run.text = run.text.replace('in cash', 'by cheque')
doc.add_page_break()
doc.add_heading('Teacher aligned marking policy version 1', 1)
doc.add_paragraph('Policy identifier ' + policy['version'] + '. These conventions record the teacher-approved treatment for this accounting test. Calibration examples are holistic marks, not a point-by-point teacher rubric.')
for heading, key in [('General marking rules', 'generalRules'), ('Exam specific conventions', 'examConventions')]:
    doc.add_heading(heading, 2)
    for text in policy[key]: doc.add_paragraph(text)
doc.add_heading('Anonymised teacher calibration', 2)
for example in policy['teacherCalibration']:
    doc.add_heading(f"Question {example['questionId']} teacher award {example['marks']} marks", 3)
    doc.add_paragraph(example['evidence'])
    doc.add_paragraph(example['explanation'])
for p in doc.paragraphs:
    for r in p.runs:
        r.font.name = 'Calibri'
        if not r.font.size: r.font.size = Pt(10)
docx_out = OUT / 'Accounting Test Solutions Teacher Aligned v1.docx'
doc.save(docx_out)

pdfmetrics.registerFont(TTFont('Calibri', 'C:/Windows/Fonts/calibri.ttf'))
pdfmetrics.registerFont(TTFont('CalibriBold', 'C:/Windows/Fonts/calibrib.ttf'))
regular = ParagraphStyle('body', fontName='Calibri', fontSize=9, leading=11, spaceAfter=6)
heading = ParagraphStyle('heading', parent=regular, fontName='CalibriBold', fontSize=11, leading=14, spaceBefore=8, keepWithNext=True)
story = []
for element in doc.element.body:
    if element.tag == qn('w:p'):
        from docx.text.paragraph import Paragraph as WordParagraph
        p = WordParagraph(element, doc)
        if p.paragraph_format.page_break_before or element.xpath('.//w:br[@w:type="page"]'):
            if story and not isinstance(story[-1], PageBreak): story.append(PageBreak())
        if p.text.strip():
            style = heading if p.style.name.startswith('Heading') or any(r.bold for r in p.runs) else regular
            story.append(Paragraph(escape(p.text).replace('\n', '<br/>'), style))
    elif element.tag == qn('w:tbl'):
        from docx.table import Table as WordTable
        table = WordTable(element, doc)
        widths = [c.width.pt if c.width else 60 for c in table.columns]
        widths = [w * 451 / sum(widths) for w in widths]
        rows = [[Paragraph(escape(c.text).replace('\n', '<br/>'), regular) for c in row.cells] for row in table.rows]
        t = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
        t.setStyle(TableStyle([('GRID', (0,0),(-1,-1),.4,colors.lightgrey),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3)]))
        story += [t, Spacer(1, 8)]
pdf_out = OUT / 'Accounting Test Solutions Teacher Aligned v1.pdf'
SimpleDocTemplate(str(pdf_out), pagesize=(595.3,841.9), leftMargin=72, rightMargin=72, topMargin=42, bottomMargin=42).build(story)
qa = ROOT / '.tmp/teacher-key-qa'
qa.mkdir(parents=True, exist_ok=True)
with pdfplumber.open(pdf_out) as pdf:
    text = '\n'.join(p.extract_text() or '' for p in pdf.pages)
    assert 'accounting-teacher-v1' in text and '5,272.81' in text and 'by cheque' in text
    for i, p in enumerate(pdf.pages): p.to_image(resolution=100).save(qa / f'page-{i+1}.png')
    print('PDF pages', len(pdf.pages))
print(pdf_out)
print(docx_out)
