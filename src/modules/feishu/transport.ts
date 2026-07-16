import { OAuthService } from "../oauthService";

const API = "https://open.feishu.cn/open-apis";

export class FeishuError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export class FeishuTransport {
  private documentReadyAt = 0;
  private mediaReadyAt = 0;
  private documentWriteQueue: Promise<void> = Promise.resolve();
  private mediaWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly oauth: OAuthService) {}

  async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.retry(async () => {
      const token = await this.oauth.getAccessToken();
      try {
        const response = await Zotero.HTTP.request(method, `${API}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: body ? JSON.stringify(body) : undefined,
          responseType: "json",
          successCodes: false,
        } as any);
        const data = parseResponse(response);
        const status = Number(response.status || 200);
        const code = numericValue(data.code);
        if (status < 200 || status >= 300 || code) {
          throw new FeishuError(
            stringValue(data.msg) || `Feishu request failed (${status})`,
            status,
            code,
          );
        }
        return parseJsonObject(data.data);
      } catch (error) {
        if (error instanceof FeishuError) throw error;
        const xhr = (error as any)?.xmlhttp;
        if (xhr) {
          const data = parseResponse(xhr);
          throw new FeishuError(
            stringValue(data.msg) || `Feishu request failed (${xhr.status})`,
            Number(xhr.status),
            numericValue(data.code),
          );
        }
        throw error;
      }
    });
  }

  async mediaRequest(
    path: string,
    body: FormData,
  ): Promise<Record<string, unknown>> {
    await this.waitForMediaWrite();
    return this.retry(async () => {
      const token = await this.oauth.getAccessToken();
      const response = await (Zotero.getMainWindow() as any).fetch(
        `${API}${path}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body,
        },
      );
      const data = parseJsonObject(await response.json());
      const code = numericValue(data.code);
      if (!response.ok || code) {
        throw new FeishuError(
          stringValue(data.msg) || `Feishu request failed (${response.status})`,
          response.status,
          code,
        );
      }
      return parseJsonObject(data.data);
    });
  }

  async waitForDocumentWrite(): Promise<void> {
    const turn = this.documentWriteQueue.then(async () => {
      const wait = Math.max(0, this.documentReadyAt - Date.now());
      if (wait) await Zotero.Promise.delay(wait);
      this.documentReadyAt = Date.now() + 350;
    });
    this.documentWriteQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryable(error) || attempt >= 4) throw error;
        const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        attempt++;
        await Zotero.Promise.delay(delay);
      }
    }
  }

  private async waitForMediaWrite(): Promise<void> {
    const turn = this.mediaWriteQueue.then(async () => {
      const wait = Math.max(0, this.mediaReadyAt - Date.now());
      if (wait) await Zotero.Promise.delay(wait);
      this.mediaReadyAt = Date.now() + 220;
    });
    this.mediaWriteQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
  }
}

function parseResponse(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object") return {};
  const response = request as Record<string, unknown>;
  if (
    response.response &&
    typeof response.response === "object" &&
    !Array.isArray(response.response)
  ) {
    return response.response as Record<string, unknown>;
  }
  try {
    return parseJsonObject(
      JSON.parse(
        typeof response.responseText === "string"
          ? response.responseText
          : "{}",
      ),
    );
  } catch {
    return {};
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof FeishuError)) return false;
  return (
    error.status === 429 ||
    Boolean(error.status && error.status >= 500) ||
    error.code === 99991400 ||
    error.code === 1061045
  );
}
