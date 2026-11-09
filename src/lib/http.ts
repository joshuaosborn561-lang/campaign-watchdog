export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

function buildUrl(
  baseUrl: string,
  path: string,
  apiKey: string | undefined,
  query?: RequestOptions["query"],
): string {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequest<T>(
  baseUrl: string,
  apiKey: string | undefined,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    query,
    body,
    headers = {},
    timeoutMs = 60_000,
    retries = 4,
  } = options;
  const url = buildUrl(baseUrl, path, apiKey, query);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const backoff = Math.min(30_000, 500 * 2 ** attempt);
          await sleep(Math.max(backoff, response.status === 429 ? (retryAfter ?? 0) : 0));
          continue;
        }
      }

      if (!response.ok) {
        const message =
          typeof parsed === "object" &&
          parsed !== null &&
          ("message" in parsed || "error" in parsed)
            ? String(
                (parsed as { message?: unknown; error?: unknown }).message ??
                  (parsed as { error?: unknown }).error,
              )
            : `HTTP ${response.status}`;
        throw new ApiError(message, response.status, parsed, retryAfter);
      }

      return parsed as T;
    } catch (error) {
      if (controller.signal.aborted) {
        lastError = new Error(`request timed out after ${timeoutMs}ms`);
      } else {
        lastError = error;
      }
      if (lastError instanceof ApiError) throw lastError;
      if (attempt < retries) {
        await sleep(Math.min(30_000, 500 * 2 ** attempt));
        continue;
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
