import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true } as dotenv.DotenvConfigOptions);
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
export const config = {
  apiKey: process.env.OPENAI_API_KEY?.trim() ?? '', model: process.env.OPENAI_MODEL?.trim() ?? '',
  port: positive('PORT', 3001), timeout: positive('MODEL_TIMEOUT_MS', 180000),
  host: process.env.HOST?.trim() || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  dataDir: process.env.DATA_DIR?.trim() || '',
  facultyPassword: process.env.FACULTY_PASSWORD || '', facultyUser: process.env.FACULTY_USER?.trim() || 'faculty',
  facultyDisplayName: process.env.FACULTY_DISPLAY_NAME?.trim() || '',
  requireFacultyAuth: process.env.NODE_ENV === 'production',
  appOrigin: process.env.APP_ORIGIN?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  maxBytes: positive('MAX_FILE_MB', 30) * 1024 * 1024,
  maxPages: positive('MAX_PDF_PAGES', 50), retentionMs: positive('RETENTION_MS', 3600000),
};
