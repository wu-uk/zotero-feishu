import { getPref, setPref } from "../utils/prefs";
import { CredentialStore } from "./credentialStore";
import type { OAuthTokens } from "./types";

export const OAUTH_CALLBACK_PATH = "/zotero-feishu/oauth/callback";
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:23119${OAUTH_CALLBACK_PATH}`;

const AUTHORIZE_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const SCOPES = [
  "docx:document",
  "docx:document.block:convert",
  "docs:document.media:upload",
  "drive:file:upload",
  "drive:drive.metadata:readonly",
  "space:document:delete",
  "offline_access",
];

interface PendingAuthorization {
  state: string;
  verifier: string;
}

export class OAuthService {
  private readonly credentials = new CredentialStore();
  private pending?: PendingAuthorization;
  private registered = false;

  registerCallback(): void {
    if (this.registered) return;
    const Endpoint = function () {} as any;
    Endpoint.prototype = {
      supportedMethods: ["GET"],
      allowRequestsFromUnsafeWebContent: true,
      init: async ({
        searchParams,
      }: {
        searchParams: URLSearchParams;
      }): Promise<[number, string, string]> => {
        try {
          await this.handleCallback(searchParams);
          return [200, "text/html; charset=utf-8", successPage()];
        } catch (error) {
          ztoolkit.log("Feishu OAuth callback failed", error);
          return [
            400,
            "text/html; charset=utf-8",
            errorPage(errorMessage(error)),
          ];
        }
      },
    };
    (Zotero.Server.Endpoints as any)[OAUTH_CALLBACK_PATH] = Endpoint;
    this.registered = true;
  }

  unregisterCallback(): void {
    if (!this.registered) return;
    delete (Zotero.Server.Endpoints as any)[OAUTH_CALLBACK_PATH];
    this.registered = false;
    this.pending = undefined;
  }

  async authorize(appId: string, appSecret: string): Promise<void> {
    const resolvedSecret =
      appSecret.trim() || this.credentials.getAppSecret() || "";
    if (!appId.trim() || !resolvedSecret) {
      throw new Error("App ID and App Secret are required");
    }
    setPref("appId", appId.trim());
    await this.credentials.setAppSecret(resolvedSecret);

    const verifier = randomBase64Url(64);
    const state = randomBase64Url(32);
    const challenge = await sha256Base64Url(verifier);
    this.pending = { state, verifier };

    const url = new (Zotero.getMainWindow() as any).URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", appId.trim());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "consent");
    Zotero.launchURL(url.toString());
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
    this.credentials.clearTokens();
    setPref("accessTokenExpiresAt", "0");
  }

  private async handleCallback(params: URLSearchParams): Promise<void> {
    const error = params.get("error");
    if (error) {
      throw new Error(params.get("error_description") || error);
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state || !this.pending || state !== this.pending.state) {
      throw new Error("Invalid or expired OAuth callback state");
    }

    const appId = String(getPref("appId") || "");
    const appSecret = this.credentials.getAppSecret();
    if (!appId || !appSecret)
      throw new Error("Missing application credentials");

    const response = await tokenRequest({
      grant_type: "authorization_code",
      client_id: appId,
      client_secret: appSecret,
      code,
      code_verifier: this.pending.verifier,
      redirect_uri: OAUTH_REDIRECT_URI,
    });
    this.pending = undefined;
    await this.saveTokenResponse(response);
  }

  private async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (tokens.refreshExpiresAt <= Date.now()) {
      this.clearAuthorization();
      throw new Error("Feishu authorization expired; authorize again");
    }
    const appId = String(getPref("appId") || "");
    const appSecret = this.credentials.getAppSecret();
    if (!appId || !appSecret)
      throw new Error("Missing application credentials");
    const response = await tokenRequest({
      grant_type: "refresh_token",
      client_id: appId,
      client_secret: appSecret,
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

function parseResponse(request: any): any {
  if (request.response && typeof request.response === "object") {
    return request.response;
  }
  return JSON.parse(request.responseText || "{}");
}

function randomBase64Url(bytes: number): string {
  const values = new Uint8Array(bytes);
  (Zotero.getMainWindow() as any).crypto.getRandomValues(values);
  return bytesToBase64Url(values);
}

async function sha256Base64Url(value: string): Promise<string> {
  const win = Zotero.getMainWindow() as any;
  const bytes = new win.TextEncoder().encode(value);
  return bytesToBase64Url(
    new Uint8Array(await win.crypto.subtle.digest("SHA-256", bytes)),
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => (binary += String.fromCharCode(value)));
  return (Zotero.getMainWindow() as any)
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successPage(): string {
  return (
    "<!doctype html><meta charset=utf-8><title>Zotero Feishu Sync</title>" +
    "<h1>Authorization complete</h1><p>You can close this tab and return to Zotero.</p>"
  );
}

function errorPage(message: string): string {
  const escaped = message.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
  return (
    "<!doctype html><meta charset=utf-8><title>Zotero Feishu Sync</title>" +
    `<h1>Authorization failed</h1><p>${escaped}</p>`
  );
}
