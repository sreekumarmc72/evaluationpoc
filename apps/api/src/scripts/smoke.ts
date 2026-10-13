import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { OpenAIModel } from '../model.js';
import { validatePdf } from '../pdf.js';
import { validateTranscription } from '../validation.js';
import { publicError } from '../errors.js';

try {
  if (!config.apiKey || !config.model) throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL in root .env first.');
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run smoke -- C:/path/to/handwritten-answer-sheet.pdf');
  const bytes = await readFile(file);
  const pages = await validatePdf(bytes, 'Answer sheet', config.maxBytes, config.maxPages);
  const model = new OpenAIModel(new OpenAI({ apiKey: config.apiKey, timeout: config.timeout, maxRetries: 2 }), config.model);
  const start = Date.now();
  const response = await model.transcribe(bytes);
  const transcription = validateTranscription(response.value, pages);
  console.log(JSON.stringify({ model: config.model, elapsedMs: Date.now() - start, usage: response.usage, transcription }, null, 2));
  console.log('PDF vision + Structured Outputs succeeded. Manually compare wording, mathematical symbols, numbering and page continuity with your scan.');
} catch (error) {
  console.error(error instanceof Error && !(error instanceof OpenAI.APIError) ? error.message : publicError(error).message);
  process.exitCode = 1;
}
