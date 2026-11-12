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
          // Smartlead's account limit is a 60s window (Retry-After: 60). The old
          // 0.5–4s backoff (~7.5s total) always gave up inside that window, and
          // callers then turned the failure into "0 sent".
          const wait = retryDelayMs(response, attempt);
          if (response.status === 429) {
            console.warn(
              `[http] 429 on ${path} — retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)}s`,
            );
          }
          await sleep(wait);
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

/** Longest a single 429 wait may be (Smartlead's window is 60s). */
export const MAX_RATE_LIMIT_WAIT_MS = 65_000;

/**
 * Delay before the next attempt. 429: honor `Retry-After` (seconds or HTTP
 * date), else `X-RateLimit-Reset` (epoch seconds, or seconds-from-now when
 * small), capped at ~65s. 5xx / network: exponential backoff.
 */
export function retryDelayMs(
  response: { status: number; headers: { get(name: string): string | null } },
  attempt: number,
  nowMs = Date.now(),
): number {
  const fallback = Math.min(30_000, 500 * 2 ** attempt);
  if (response.status !== 429) return fallback;
  const cap = (ms: number) => Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1_000, ms));

  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return cap(seconds * 1000 + 250);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return cap(at - nowMs + 250);
  }

  const resetRaw = response.headers.get("x-ratelimit-reset")?.trim();
  const reset = resetRaw ? Number(resetRaw) : NaN;
  if (Number.isFinite(reset) && reset > 0) {
    // Epoch seconds (Smartlead) vs. a relative seconds count.
    const wait = reset > 1e9 ? reset * 1000 - nowMs + 250 : reset * 1000 + 250;
    return cap(wait);
  }

  // 429 without hints: wait long enough to clear most of a 60s window.
  return cap(Math.max(fallback, 15_000));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
