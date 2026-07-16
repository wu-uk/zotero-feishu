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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface OAuthServiceDependencies {
  requestToken(body: Record<string, string>): Promise<unknown>;
  now(): number;
}

export class AuthorizationChangedError extends Error {}

export class OAuthService {
  private pending?: AbortController;
  private refreshPromise?: Promise<OAuthTokens>;
  private authorizationEpoch = 0;

  constructor(
    private readonly deviceAuth = new FeishuDeviceAuth(),
    private readonly credentials = new CredentialStore(),
    private readonly dependencies: OAuthServiceDependencies = {
      requestToken: tokenRequest,
      now: () => Date.now(),
    },
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
    if (tokens.expiresAt > this.dependencies.now() + 60_000) {
      return tokens.accessToken;
    }
    if (!this.refreshPromise) {
      const epoch = this.authorizationEpoch;
      const refresh = this.refresh(tokens, epoch);
      this.refreshPromise = refresh;
      void refresh.then(
        () => this.clearRefreshPromise(refresh),
        () => this.clearRefreshPromise(refresh),
      );
    }
    return (await this.refreshPromise).accessToken;
  }

  isAuthorized(): boolean {
    return Boolean(this.credentials.getTokens()?.refreshToken);
  }

  clearAuthorization(): void {
    this.authorizationEpoch++;
    this.cancelPendingAuthorization();
    this.credentials.clearTokens();
    setPref("accessTokenExpiresAt", "0");
  }

  private clearApplication(): void {
    this.authorizationEpoch++;
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
    const epoch = ++this.authorizationEpoch;
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
      this.assertEpoch(epoch);
      await this.saveApplication(app);
      const response = await this.deviceAuth.authorizeUser(
        app,
        onProgress,
        controller.signal,
      );
      await this.saveTokenResponse(response, epoch);
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

  private async refresh(
    tokens: OAuthTokens,
    epoch: number,
  ): Promise<OAuthTokens> {
    if (tokens.refreshExpiresAt <= this.dependencies.now()) {
      this.clearAuthorization();
      throw new Error("Feishu authorization expired; authorize again");
    }
    const app = this.getConfiguredApplication();
    if (!app) throw new Error("Missing application credentials");
    const response = await this.dependencies.requestToken({
      grant_type: "refresh_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      refresh_token: tokens.refreshToken,
    });
    return this.saveTokenResponse(response, epoch);
  }

  private async saveTokenResponse(
    responseValue: unknown,
    epoch: number,
  ): Promise<OAuthTokens> {
    this.assertEpoch(epoch);
    const response = parseTokenResponse(responseValue);
    const now = this.dependencies.now();
    const previous = this.credentials.getTokens();
    const tokens: OAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token || previous?.refreshToken || "",
      expiresAt: now + response.expires_in * 1000,
      refreshExpiresAt: response.refresh_token_expires_in
        ? now + response.refresh_token_expires_in * 1000
        : previous?.refreshExpiresAt || 0,
      scope: response.scope || previous?.scope || "",
    };
    if (!tokens.refreshToken) {
      throw new Error("Feishu returned an incomplete OAuth token response");
    }
    this.assertEpoch(epoch);
    await this.credentials.setTokens(tokens);
    if (epoch !== this.authorizationEpoch) {
      const current = this.credentials.getTokens();
      if (
        current?.accessToken === tokens.accessToken &&
        current.refreshToken === tokens.refreshToken
      ) {
        this.credentials.clearTokens();
      }
      this.assertEpoch(epoch);
    }
    setPref("accessTokenExpiresAt", String(tokens.expiresAt));
    return tokens;
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.authorizationEpoch) {
      throw new AuthorizationChangedError(
        "Feishu authorization changed while a token request was in progress",
      );
    }
  }

  private clearRefreshPromise(refresh: Promise<OAuthTokens>): void {
    if (this.refreshPromise === refresh) this.refreshPromise = undefined;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<unknown> {
  const request = await Zotero.HTTP.request("POST", TOKEN_URL, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    responseType: "json",
  });
  const response = parseResponse(request);
  const code = numberField(response.code);
  if (code !== undefined && code !== 0) {
    throw new Error(
      stringField(response.error_description) ||
        stringField(response.error) ||
        `OAuth error ${code}`,
    );
  }
  return response;
}

function createAbortController(): AbortController {
  const Constructor = (Zotero.getMainWindow() as any).AbortController;
  return new Constructor();
}

function parseResponse(request: unknown): Record<string, unknown> {
  if (!isObject(request)) return {};
  if (isObject(request.response)) return request.response;
  const responseText =
    typeof request.responseText === "string" ? request.responseText : "{}";
  const parsed = JSON.parse(responseText);
  return isObject(parsed) ? parsed : {};
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isObject(value)) {
    throw new Error("Feishu returned an invalid OAuth token response");
  }
  const accessToken = stringField(value.access_token);
  const expiresIn = numberField(value.expires_in);
  if (!accessToken || !expiresIn || expiresIn <= 0) {
    throw new Error("Feishu returned an incomplete OAuth token response");
  }
  return {
    access_token: accessToken,
    expires_in: expiresIn,
    ...(stringField(value.refresh_token)
      ? { refresh_token: stringField(value.refresh_token) }
      : {}),
    ...(positiveNumberField(value.refresh_token_expires_in)
      ? {
          refresh_token_expires_in: positiveNumberField(
            value.refresh_token_expires_in,
          ),
        }
      : {}),
    ...(stringField(value.scope) ? { scope: stringField(value.scope) } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveNumberField(value: unknown): number | undefined {
  const number = numberField(value);
  return number && number > 0 ? number : undefined;
}
