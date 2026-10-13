import OpenAI from 'openai';
import { config } from '../config.js';
import { publicError } from '../errors.js';
import { get } from 'node:http';

// Metadata lookup only: no PDF upload and no generation/token usage.
for (const port of [config.port, 5173]) {
  try {
    const ok = await new Promise<boolean>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}/api/health`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(body).ok === true); } catch { reject(new Error('Invalid health response.')); } });
        response.on('error', reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error('Local connection timed out.')));
      request.on('error', reject);
    });
    console.log(JSON.stringify({ check: port === config.port ? 'backend' : 'web_proxy', ok }));
  } catch (error) { console.log(JSON.stringify({ check: port === config.port ? 'backend' : 'web_proxy', ok: false, message: 'Local server unreachable.', transportCode: (error as { code?: string }).code, detail: error instanceof Error ? error.message : 'Unknown local connection error' })); }
}
const start = Date.now();
try {
  if (!config.apiKey || !config.model) throw new Error('Configure backend API key and model first.');
  const client = new OpenAI({ apiKey: config.apiKey, timeout: 15000, maxRetries: 0 });
  const result = await client.models.retrieve(config.model);
  console.log(JSON.stringify({ check: 'openai_model_access', ok: true, model: result.id, elapsedMs: Date.now() - start, requestId: result._request_id, generationPerformed: false }));
} catch (error) {
  const safe = publicError(error);
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
  console.log(JSON.stringify({ check: 'openai_model_access', ok: false, elapsedMs: Date.now() - start, code: safe.code, message: safe.message, transportCode: cause, requestId: error instanceof OpenAI.APIError ? error.requestID : undefined }));
  process.exitCode = 1;
}
