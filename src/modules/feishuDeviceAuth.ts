import { version } from "../../package.json";

export const FEISHU_SCOPES = [
  "docx:document",
  "docx:document.block:convert",
  "docs:document.media:upload",
  "drive:file:upload",
  "drive:drive.metadata:readonly",
  "space:document:delete",
  "offline_access",
] as const;

const ACCOUNTS = "https://accounts.feishu.cn";
const OPEN = "https://open.feishu.cn";
const REGISTRATION_URL = `${ACCOUNTS}/oauth/v1/app/registration`;
const DEVICE_AUTHORIZATION_URL = `${ACCOUNTS}/oauth/v1/device_authorization`;
const TOKEN_URL = `${OPEN}/open-apis/authen/v2/oauth/token`;

export type AuthorizationPhase =
  | "registering_app"
  | "waiting_app_registration"
  | "waiting_app_permissions"
  | "requesting_user_authorization"
  | "waiting_user_authorization"
  | "authorized";

export interface AuthorizationProgress {
  phase: AuthorizationPhase;
  verificationUrl?: string;
  consoleUrl?: string;
  missingScopes?: string[];
}

export type ProgressCallback = (progress: AuthorizationProgress) => void;

export class AuthorizationCancelledError extends Error {}

export class MissingAppPermissionsError extends Error {
  constructor(
    public readonly missingScopes: string[],
    public readonly consoleUrl: string,
  ) {
    super(`Missing Feishu app permissions: ${missingScopes.join(", ")}`);
  }
}

export class InvalidFeishuApplicationError extends Error {}

export interface RegisteredApp {
  appId: string;
  appSecret: string;
}

export interface DeviceTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  scope: string;
}

interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResult {
  status: number;
  data: any;
}

export interface DeviceAuthDependencies {
  request(
    method: string,
    url: string,
    options?: RequestOptions,
  ): Promise<HttpResult>;
  delay(milliseconds: number): Promise<void>;
  now(): number;
  launchURL(url: string): void;
}

export class FeishuDeviceAuth {
  constructor(
    private readonly dependencies: DeviceAuthDependencies = defaultDependencies(),
  ) {}

  async registerApplication(
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<RegisteredApp> {
    assertActive(signal);
    onProgress?.({ phase: "registering_app" });
    const response = await this.formRequest(REGISTRATION_URL, {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    });
    assertSuccess(response, "Unable to start Feishu app registration");
    const deviceCode = requiredString(response.data, "device_code");
    const userCode = requiredString(response.data, "user_code");
    const verificationUrl =
      response.data.verification_uri_complete ||
      `${OPEN}/page/cli?user_code=${encodeURIComponent(userCode)}` +
        `&lpv=${encodeURIComponent(version)}` +
        `&ocv=${encodeURIComponent(version)}&from=cli`;
    onProgress?.({
      phase: "waiting_app_registration",
      verificationUrl,
    });
    this.dependencies.launchURL(verificationUrl);

    const data = await this.poll(
      {
        url: REGISTRATION_URL,
        body: { action: "poll", device_code: deviceCode },
        interval: numberValue(response.data.interval, 5),
        expiresIn: numberValue(response.data.expires_in, 300),
      },
      signal,
    );
    const appId = requiredString(data, "client_id");
    const appSecret = requiredString(data, "client_secret");
    return { appId, appSecret };
  }

  async authorizeUser(
    app: RegisteredApp,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<DeviceTokenResponse> {
    assertActive(signal);
    onProgress?.({ phase: "requesting_user_authorization" });
    const response = await this.formRequest(
      DEVICE_AUTHORIZATION_URL,
      {
        client_id: app.appId,
        scope: FEISHU_SCOPES.join(" "),
      },
      {
        Authorization: `Basic ${base64(`${app.appId}:${app.appSecret}`)}`,
      },
    );
    try {
      assertSuccess(response, "Unable to start Feishu account authorization");
    } catch (error) {
      if (isInvalidApplication(response.data)) {
        throw new InvalidFeishuApplicationError(responseMessage(response.data));
      }
      if (!isPermissionFailure(response.data)) throw error;
      this.openPermissionSettings(
        app.appId,
        permissionScopes(response.data),
        onProgress,
      );
    }
    const verificationUrl =
      response.data.verification_uri_complete ||
      requiredString(response.data, "verification_uri");
    onProgress?.({
      phase: "waiting_user_authorization",
      verificationUrl,
    });
    this.dependencies.launchURL(verificationUrl);

    const data = await this.poll(
      {
        url: TOKEN_URL,
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: requiredString(response.data, "device_code"),
          client_id: app.appId,
          client_secret: app.appSecret,
        },
        interval: numberValue(response.data.interval, 5),
        expiresIn: numberValue(response.data.expires_in, 240),
      },
      signal,
    );
    const token = data as DeviceTokenResponse;
    if (!token.access_token || !token.refresh_token) {
      throw new Error("Feishu returned an incomplete OAuth token response");
    }
    const missingScopes = missingGrantedScopes(token.scope || "");
    if (missingScopes.length) {
      this.openPermissionSettings(app.appId, missingScopes, onProgress);
    }
    onProgress?.({ phase: "authorized" });
    return token;
  }

  private openPermissionSettings(
    appId: string,
    missingScopes: string[],
    onProgress?: ProgressCallback,
  ): never {
    const consoleUrl = permissionConsoleUrl(appId, missingScopes);
    onProgress?.({
      phase: "waiting_app_permissions",
      consoleUrl,
      missingScopes,
    });
    this.dependencies.launchURL(consoleUrl);
    throw new MissingAppPermissionsError(missingScopes, consoleUrl);
  }

  private async poll(
    options: {
      url: string;
      body: Record<string, string>;
      interval: number;
      expiresIn: number;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const deadline = this.dependencies.now() + options.expiresIn * 1000;
    let interval = Math.max(1, options.interval);
    while (this.dependencies.now() < deadline) {
      await this.wait(interval * 1000, signal);
      let response: HttpResult;
      try {
        response = await this.formRequest(options.url, options.body);
      } catch (error) {
        if (this.dependencies.now() >= deadline) throw error;
        interval = Math.min(60, interval + 1);
        continue;
      }
      const error = response.data?.error;
      if (!error && response.status >= 200 && response.status < 300) {
        return response.data;
      }
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval = Math.min(60, interval + 5);
        continue;
      }
      if (error === "access_denied") {
        throw new Error("Feishu authorization was denied");
      }
      if (error === "expired_token" || error === "invalid_grant") {
        throw new Error("Feishu authorization expired; try again");
      }
      if (isInvalidApplication(response.data)) {
        throw new InvalidFeishuApplicationError(responseMessage(response.data));
      }
      assertSuccess(response, "Feishu authorization failed");
    }
    throw new Error("Feishu authorization timed out; try again");
  }

  private formRequest(
    url: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    return this.dependencies.request("POST", url, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: formEncode(body),
    });
  }

  private async wait(milliseconds: number, signal?: AbortSignal) {
    assertActive(signal);
    await this.dependencies.delay(milliseconds);
    assertActive(signal);
  }
}

function defaultDependencies(): DeviceAuthDependencies {
  return {
    request: async (method, url, options = {}) => {
      const response = await Zotero.HTTP.request(method, url, {
        headers: options.headers,
        body: options.body,
        responseType: "json",
        successCodes: false,
      } as any);
      return {
        status: Number(response.status || 200),
        data: parseResponse(response),
      };
    },
    delay: (milliseconds) => Zotero.Promise.delay(milliseconds),
    now: () => Date.now(),
    launchURL: (url) => Zotero.launchURL(url),
  };
}

function assertSuccess(response: HttpResult, fallback: string): void {
  const data = response.data || {};
  if (
    response.status >= 200 &&
    response.status < 300 &&
    !data.error &&
    (!data.code || data.code === 0)
  ) {
    return;
  }
  throw new Error(data.error_description || data.msg || data.error || fallback);
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthorizationCancelledError();
}

function requiredString(data: any, key: string): string {
  const value = data?.[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Feishu response is missing ${key}`);
  }
  return value;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function formEncode(body: Record<string, string>): string {
  return Object.entries(body)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function missingGrantedScopes(scope: string): string[] {
  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return FEISHU_SCOPES.filter(
    (required) => required !== "offline_access" && !granted.has(required),
  );
}

function isPermissionFailure(data: any): boolean {
  return /scope|permission|权限|99991679/i.test(JSON.stringify(data || {}));
}

function isInvalidApplication(data: any): boolean {
  return /invalid_client|specified app(?:lication)? is not enabled|app(?:lication)?[^\n]*(not found|deleted)|应用[^\n]*(不存在|已删除)/i.test(
    JSON.stringify(data || {}),
  );
}

function responseMessage(data: any): string {
  return (
    data?.error_description ||
    data?.msg ||
    data?.error ||
    "The configured Feishu app is unavailable"
  );
}

function permissionScopes(data: any): string[] {
  const description = JSON.stringify(data || {});
  const mentioned = FEISHU_SCOPES.filter(
    (scope) =>
      scope !== "offline_access" &&
      new RegExp(
        `(^|[^a-z0-9:._-])${escapeRegExp(scope)}` + "($|[^a-z0-9:._-])",
        "i",
      ).test(description),
  );
  return mentioned.length
    ? mentioned
    : FEISHU_SCOPES.filter((scope) => scope !== "offline_access");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function permissionConsoleUrl(appId: string, scopes: string[]): string {
  const query = encodeURIComponent(scopes.join(","));
  return `${OPEN}/app/${encodeURIComponent(appId)}/auth?q=${query}`;
}

function base64(value: string): string {
  return (Zotero.getMainWindow() as any).btoa(value);
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
