import { config } from "../../package.json";
import type { OAuthTokens } from "./types";

const ORIGIN = `chrome://${config.addonRef}`;
const REALM = config.addonID;
const APP_SECRET_USER = "app-secret";
const TOKENS_USER = "oauth-tokens";

export class CredentialStore {
  private get loginManager(): any {
    return (ztoolkit.getGlobal("Services") as any).logins;
  }

  private find(username: string): any | undefined {
    return this.loginManager
      .findLogins(ORIGIN, null, REALM)
      .find((login: any) => login.username === username);
  }

  private async set(username: string, password: string): Promise<void> {
    const current = this.find(username);
    if (current) {
      const replacement = this.createLogin(username, password);
      this.loginManager.modifyLogin(current, replacement);
      return;
    }

    const login = this.createLogin(username, password);
    if (typeof this.loginManager.addLoginAsync === "function") {
      await this.loginManager.addLoginAsync(login);
      return;
    }
    this.loginManager.addLogin(login);
  }

  private createLogin(username: string, password: string): any {
    const components = ztoolkit.getGlobal("Components") as any;
    const LoginInfo = components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      "nsILoginInfo",
      "init",
    );
    return new LoginInfo(ORIGIN, null, REALM, username, password, "", "");
  }

  getAppSecret(): string | undefined {
    return this.find(APP_SECRET_USER)?.password || undefined;
  }

  async setAppSecret(secret: string): Promise<void> {
    await this.set(APP_SECRET_USER, secret);
  }

  getTokens(): OAuthTokens | undefined {
    const raw = this.find(TOKENS_USER)?.password;
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    await this.set(TOKENS_USER, JSON.stringify(tokens));
  }

  clearTokens(): void {
    const login = this.find(TOKENS_USER);
    if (login) this.loginManager.removeLogin(login);
  }
}
