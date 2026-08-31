export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
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

      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
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
        throw new ApiError(message, response.status, parsed);
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
