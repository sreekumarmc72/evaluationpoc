import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { validatePdf } from './pdf.js';
export async function makePdf(pages = 1) { const doc = await PDFDocument.create(); for (let i = 0; i < pages; i++) doc.addPage(); return Buffer.from(await doc.save({ addDefaultPage: false })); }
describe('PDF validation', () => {
  it('accepts a genuine PDF regardless of its filename', async () => { expect(await validatePdf(await makePdf(), 'File', 100000, 10)).toBe(1); });
  it('rejects empty, disguised, corrupt, oversized and zero-page PDFs', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not a PDF'), Buffer.from('%PDF-1.7 garbage'), await makePdf(0)]) await expect(validatePdf(bytes, 'File', 100000, 10)).rejects.toThrow();
    await expect(validatePdf(await makePdf(), 'File', 1, 10)).rejects.toThrow(/exceeds/);
  });
  it('rejects excess pages and encrypted PDFs', async () => {
    await expect(validatePdf(await makePdf(2), 'File', 100000, 1)).rejects.toThrow(/pages/);
    const encrypted = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n3 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (abc) /U (abc) /P -4 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 3 0 R /Size 4 >>\n%%EOF');
    await expect(validatePdf(encrypted, 'File', 100000, 10)).rejects.toThrow(/encrypted/);
  });
});
