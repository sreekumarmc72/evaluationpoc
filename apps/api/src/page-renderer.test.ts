import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { expect, it } from 'vitest';
import { createPageRenderer } from './page-renderer.js';
const available = !spawnSync(process.env.PDFTOPPM_PATH || 'pdftoppm', ['-v'], { windowsHide: true }).error;
it.skipIf(!available)('renders original PDF pages and bounded crops with the actual Poppler runtime', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 600]).drawText('First page'); pdf.addPage([400, 600]).drawText('Second page');
  const renderer = await createPageRenderer(Buffer.from(await pdf.save()));
  try {
    expect(renderer.count).toBe(2); const full = await renderer.render(2); expect(full.height).toBe(2400); expect(full.width).toBe(1600);
    const crop = await renderer.render(2, { x0: 0, y0: 0, x1: 500, y1: 500 }); expect(crop.width).toBeLessThan(full.width); expect(crop.height).toBeLessThan(full.height);
    await expect(renderer.render(3)).rejects.toThrow(/Invalid page/); await expect(renderer.render(2, { x0: 800, y0: 0, x1: 500, y1: 500 })).rejects.toThrow(/Invalid reading crop/);
  } finally { await renderer.dispose(); }
});
