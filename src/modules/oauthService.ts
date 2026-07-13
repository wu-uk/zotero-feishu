import { getPref, setPref } from "../utils/prefs";
import { CredentialStore } from "./credentialStore";
import {
  FeishuDeviceAuth,
  InvalidFeishuApplicationError,
  type ProgressCallback,
  type RegisteredApp,
} from "./feishuDeviceAuth";
import type { OAuthTokens } from "./types";

const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

export class OAuthService {
  private pending?: AbortController;

  constructor(
    private readonly deviceAuth = new FeishuDeviceAuth(),
    private readonly credentials = new CredentialStore(),
  ) {}

  async startAutomaticAuthorization(
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const configuredApp = this.getConfiguredApplication();
    try {
      return await this.runAuthorization(configuredApp, onProgress);
    } catch (error) {
      if (!(error instanceof InvalidFeishuApplicationError)) throw error;
      this.clearApplication();
      return this.runAuthorization(undefined, onProgress);
    }
  }

  cancelPendingAuthorization(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  async getAccessToken(): Promise<string> {
    const tokens = this.credentials.getTokens();
    if (!tokens) throw new Error("Feishu account is not authorized");
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    return (await this.refresh(tokens)).accessToken;
  }

  isAuthorized(): boolean {
    return Boolean(this.credentials.getTokens()?.refreshToken);
  }

  clearAuthorization(): void {
    this.cancelPendingAuthorization();
    this.credentials.clearTokens();
    setPref("accessTokenExpiresAt", "0");
  }

  private clearApplication(): void {
    this.credentials.clearAppSecret();
    this.credentials.clearTokens();
    setPref("appId", "");
    setPref("accessTokenExpiresAt", "0");
  }

  private async runAuthorization(
    configuredApp: RegisteredApp | undefined,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    this.cancelPendingAuthorization();
    const controller = createAbortController();
    this.pending = controller;
    try {
      const app =
        configuredApp ||
        this.getConfiguredApplication() ||
        (await this.deviceAuth.registerApplication(
          onProgress,
          controller.signal,
        ));
      await this.saveApplication(app);
      const response = await this.deviceAuth.authorizeUser(
        app,
        onProgress,
        controller.signal,
      );
      await this.saveTokenResponse(response);
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  private getConfiguredApplication(): RegisteredApp | undefined {
    const appId = String(getPref("appId") || "").trim();
    const appSecret = this.credentials.getAppSecret();
    if (!appId || !appSecret) return undefined;
    return { appId, appSecret };
  }

  private async saveApplication(app: RegisteredApp): Promise<void> {
    setPref("appId", app.appId);
    await this.credentials.setAppSecret(app.appSecret);
  }

  private async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (tokens.refreshExpiresAt <= Date.now()) {
      this.clearAuthorization();
      throw new Error("Feishu authorization expired; authorize again");
    }
    const app = this.getConfiguredApplication();
    if (!app) throw new Error("Missing application credentials");
    const response = await tokenRequest({
      grant_type: "refresh_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      refresh_token: tokens.refreshToken,
    });
    return this.saveTokenResponse(response);
  }

  private async saveTokenResponse(response: any): Promise<OAuthTokens> {
    const now = Date.now();
    const previous = this.credentials.getTokens();
    const tokens: OAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token || previous?.refreshToken || "",
      expiresAt: now + Number(response.expires_in || 0) * 1000,
      refreshExpiresAt: response.refresh_token_expires_in
        ? now + Number(response.refresh_token_expires_in) * 1000
        : previous?.refreshExpiresAt || 0,
      scope: response.scope || previous?.scope || "",
    };
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new Error("Feishu returned an incomplete OAuth token response");
    }
    await this.credentials.setTokens(tokens);
    setPref("accessTokenExpiresAt", String(tokens.expiresAt));
    return tokens;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const request = await Zotero.HTTP.request("POST", TOKEN_URL, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    responseType: "json",
  });
  const response = parseResponse(request);
  if (response.code && response.code !== 0) {
    throw new Error(
      response.error_description ||
        response.error ||
        `OAuth error ${response.code}`,
    );
  }
  return response;
}

function createAbortController(): AbortController {
  const Constructor = (Zotero.getMainWindow() as any).AbortController;
  return new Constructor();
}

function parseResponse(request: any): any {
  if (request.response && typeof request.response === "object") {
    return request.response;
  }
  return JSON.parse(request.responseText || "{}");
}
