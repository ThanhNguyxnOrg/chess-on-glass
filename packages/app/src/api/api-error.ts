/** The only JSON error shape the local API returns; never carries internals. */
export type ApiErrorBody = {
  error: { code: string; message: string };
};

export function apiError(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}
