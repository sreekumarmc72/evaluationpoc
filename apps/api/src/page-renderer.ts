import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { AppError } from './errors.js';

const execute = promisify(execFile);
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type PageImage = { page: number; data: Buffer; width: number; height: number };
export interface PageRenderer { count: number; render(page: number, box?: Box): Promise<PageImage>; dispose(): Promise<void> }
// One native rasterizer at a time bounds memory even with two model requests.
let rendering = Promise.resolve();
export async function createPageRenderer(pdf: Buffer): Promise<PageRenderer> {
  const count = (await PDFDocument.load(pdf)).getPageCount();
  const directory = await mkdtemp(path.join(tmpdir(), 'paperwise-pages-'));
  const cleanup = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('paperwise-pages-')) throw new Error('Unsafe page-rendering temporary directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  const input = path.join(directory, 'source.pdf');
  try { await writeFile(input, pdf, { flag: 'wx' }); }
  catch (error) { await cleanup(); throw error; }
  let sequence = 0; const sizes = new Map<number, { width: number; height: number }>();
  return { count, async render(page, box) {
    if (!Number.isInteger(page) || page < 1 || page > count) throw new AppError('INVALID_PAGE', 'Invalid page requested for reading.');
    if (box && (!sizes.has(page) || Object.values(box).some(n => !Number.isFinite(n) || n < 0 || n > 1000) || box.x1 <= box.x0 || box.y1 <= box.y0)) throw new AppError('INVALID_CROP', 'Invalid reading crop; the source page is retained.');
    const work = async () => {
      const output = path.join(directory, `page-${page}-${++sequence}`);
      const args = ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2400', '-png'];
      if (box) {
        const size = sizes.get(page)!; const padX = (box.x1 - box.x0) * 0.1; const padY = (box.y1 - box.y0) * 0.1;
        const x = Math.floor(Math.max(0, box.x0 - padX) / 1000 * size.width); const y = Math.floor(Math.max(0, box.y0 - padY) / 1000 * size.height);
        const right = Math.ceil(Math.min(1000, box.x1 + padX) / 1000 * size.width); const bottom = Math.ceil(Math.min(1000, box.y1 + padY) / 1000 * size.height);
        args.push('-x', String(x), '-y', String(y), '-W', String(right - x), '-H', String(bottom - y));
      }
      try {
        await execute(process.env.PDFTOPPM_PATH || 'pdftoppm', [...args, input, output], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
        const filename = `${output}.png`; const data = await readFile(filename); await rm(filename);
        if (data.length < 24 || data.subarray(1, 4).toString() !== 'PNG') throw new Error('Invalid raster image');
        const image = { page, data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
        if (!box) sizes.set(page, image); return image;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('PDF_RENDERER_UNAVAILABLE', 'PDF page rendering is unavailable. Install Poppler or configure PDFTOPPM_PATH on the backend.', 503);
        throw new AppError('PDF_RENDER_FAILED', `Could not render answer-sheet page ${page}. The original PDF is retained.`, 422);
      }
    };
    const result = rendering.then(work); rendering = result.then(() => {}, () => {}); return result;
  }, async dispose() { await rendering; await cleanup(); } };
}
