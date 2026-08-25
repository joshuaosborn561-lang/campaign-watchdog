import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface SlackTokenBundle {
  accessToken: string;
  refreshToken?: string;
}

export interface SlackClientOptions {
  channelId: string;
  botToken?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenFilePath?: string;
}

export class SlackClient {
  private accessToken: string;
  private refreshToken: string;

  constructor(private readonly options: SlackClientOptions) {
    this.accessToken = (options.accessToken || options.botToken || "").trim();
    this.refreshToken = options.refreshToken?.trim() ?? "";
  }

  tokenBundle(): SlackTokenBundle {
    return { accessToken: this.accessToken, refreshToken: this.refreshToken || undefined };
  }

  async post(text: string): Promise<void> {
    if (!this.accessToken) {
      throw new Error("Slack is not configured. Set SLACK_BOT_TOKEN or SLACK_ACCESS_TOKEN.");
    }
    try {
      await this.postMessage(text);
    } catch (error) {
      if (this.canRefresh() && isAuthError(error)) {
        await this.refresh();
        await this.postMessage(text);
        return;
      }
      throw error;
    }
  }

  private canRefresh(): boolean {
    return Boolean(
      this.refreshToken && this.options.clientId && this.options.clientSecret,
    );
  }

  async refresh(): Promise<SlackTokenBundle> {
    if (!this.canRefresh()) {
      throw new Error("Slack refresh token / client credentials are missing");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.options.clientId!,
      client_secret: this.options.clientSecret!,
    });
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await response.json()) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
    };
    if (!json.ok || !json.access_token) {
      throw new Error(`Slack token refresh failed: ${json.error || `HTTP ${response.status}`}`);
    }
    this.accessToken = json.access_token;
    if (json.refresh_token) this.refreshToken = json.refresh_token;
    await this.persistTokens();
    return this.tokenBundle();
  }

  private async persistTokens(): Promise<void> {
    const filePath = this.options.tokenFilePath;
    if (!filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        {
          access_token: this.accessToken,
          refresh_token: this.refreshToken || undefined,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  private async postMessage(text: string): Promise<void> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: this.options.channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const json = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !json.ok) {
      const error = new Error(
        `Slack chat.postMessage failed: ${json.error || `HTTP ${response.status}`}`,
      );
      (error as Error & { slackError?: string }).slackError = json.error;
      throw error;
    }
  }
}

function isAuthError(error: unknown): boolean {
  const slackError =
    error && typeof error === "object" && "slackError" in error
      ? String((error as { slackError?: unknown }).slackError)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return /invalid_auth|token_expired|token_revoked|not_authed|account_inactive/i.test(
    `${slackError} ${message}`,
  );
}
