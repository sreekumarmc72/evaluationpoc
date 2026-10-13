import { PDFDocument } from 'pdf-lib';
import { AppError } from './errors.js';
export async function validatePdf(buffer: Buffer, label: string, maxBytes: number, maxPages: number) {
  if (buffer.length === 0) throw new AppError('EMPTY_PDF', `${label} is empty.`, 400);
  if (buffer.length > maxBytes) throw new AppError('FILE_TOO_LARGE', `${label} exceeds the ${maxBytes / 1024 / 1024} MB limit.`, 413);
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new AppError('INVALID_PDF', `${label} is not a PDF document.`, 400);
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: false, throwOnInvalidObject: true });
    if (doc.isEncrypted) throw new AppError('ENCRYPTED_PDF', `${label} is encrypted. Upload an unencrypted PDF.`, 400);
    const pages = doc.getPageCount();
    if (!pages) throw new AppError('EMPTY_PDF', `${label} has no pages.`, 400);
    if (pages > maxPages) throw new AppError('TOO_MANY_PAGES', `${label} has ${pages} pages; the limit is ${maxPages}.`, 400);
    return pages;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && /encrypt/i.test(error.message)) throw new AppError('ENCRYPTED_PDF', `${label} is encrypted. Upload an unencrypted PDF.`, 400);
    throw new AppError('INVALID_PDF', `${label} is corrupt or unreadable. Export or scan it again.`, 400);
  }
}
