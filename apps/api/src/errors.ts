import OpenAI from 'openai';
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); }
}
export function publicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new AppError('MODEL_TIMEOUT', 'The model call timed out. Start a new evaluation or try a smaller, clearer PDF.', 504);
  if (error instanceof OpenAI.APIConnectionError) return new AppError('MODEL_CONNECTION', 'The backend lost its connection to OpenAI. Check internet, VPN, proxy or firewall connectivity. Earlier processing stages may already have used tokens.', 502);
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new AppError('MODEL_ACCESS', 'Check the backend API key and access to the configured model.', 502);
    if (status === 429) return new AppError('MODEL_RATE_LIMIT', 'The API rate or usage limit was reached. Check your account limits and try later.', 503);
    if (status === 400 || status === 404) return new AppError('MODEL_REQUEST', 'The configured model or PDF/Structured Outputs request was rejected. Verify the model ID and run the smoke test.', 502);
    return new AppError('MODEL_UNAVAILABLE', 'The model service could not complete the request. Try again later.', 502);
  }
  return new AppError('INTERNAL_ERROR', 'An unexpected processing error occurred. Start a new evaluation.', 500);
}
