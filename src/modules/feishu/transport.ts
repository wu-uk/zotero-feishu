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

  constructor(private readonly oauth: OAuthService) {}

  async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
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
        if (status < 200 || status >= 300 || data.code) {
          throw new FeishuError(
            data.msg || `Feishu request failed (${status})`,
            status,
            data.code,
          );
        }
        return data.data || {};
      } catch (error) {
        if (error instanceof FeishuError) throw error;
        const xhr = (error as any)?.xmlhttp;
        if (xhr) {
          const data = parseResponse(xhr);
          throw new FeishuError(
            data.msg || `Feishu request failed (${xhr.status})`,
            Number(xhr.status),
            data.code,
          );
        }
        throw error;
      }
    });
  }

  async mediaRequest(path: string, body: FormData): Promise<any> {
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
      const data = (await response.json()) as any;
      if (!response.ok || data.code) {
        throw new FeishuError(
          data.msg || `Feishu request failed (${response.status})`,
          response.status,
          data.code,
        );
      }
      return data.data || {};
    });
  }

  async waitForDocumentWrite(): Promise<void> {
    const wait = Math.max(0, this.documentReadyAt - Date.now());
    if (wait) await Zotero.Promise.delay(wait);
    this.documentReadyAt = Date.now() + 350;
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
    const wait = Math.max(0, this.mediaReadyAt - Date.now());
    if (wait) await Zotero.Promise.delay(wait);
    this.mediaReadyAt = Date.now() + 220;
  }
}

function parseResponse(request: any): any {
  if (request.response && typeof request.response === "object") {
    return request.response;
  }
  try {
    return JSON.parse(request.responseText || "{}");
  } catch {
    return {};
  }
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
