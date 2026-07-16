import { assert } from "chai";
import { setPref } from "../src/utils/prefs";
import type { CredentialStore } from "../src/modules/credentialStore";
import {
  AuthorizationChangedError,
  OAuthService,
} from "../src/modules/oauthService";
import type { OAuthTokens } from "../src/modules/types";

describe("OAuthService", function () {
  afterEach(function () {
    setPref("appId", "");
    setPref("accessTokenExpiresAt", "0");
  });

  it("shares one refresh request between concurrent callers", async function () {
    const credentials = new MemoryCredentials(expiredTokens());
    const request = deferred<unknown>();
    let refreshCalls = 0;
    setPref("appId", "cli_test");
    const service = new OAuthService(
      undefined,
      credentials as unknown as CredentialStore,
      {
        now: () => 1000,
        requestToken: async () => {
          refreshCalls++;
          return request.promise;
        },
      },
    );

    const first = service.getAccessToken();
    const second = service.getAccessToken();
    request.resolve({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 7200,
      refresh_token_expires_in: 604800,
      scope: "offline_access",
    });

    assert.deepEqual(await Promise.all([first, second]), [
      "fresh-access",
      "fresh-access",
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(credentials.setCalls, 1);
  });

  it("does not restore tokens after authorization is cleared", async function () {
    const credentials = new MemoryCredentials(expiredTokens());
    const request = deferred<unknown>();
    setPref("appId", "cli_test");
    const service = new OAuthService(
      undefined,
      credentials as unknown as CredentialStore,
      {
        now: () => 1000,
        requestToken: async () => request.promise,
      },
    );

    const refresh = service.getAccessToken();
    service.clearAuthorization();
    request.resolve({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_in: 7200,
      refresh_token_expires_in: 604800,
    });

    let caught: unknown;
    try {
      await refresh;
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, AuthorizationChangedError);
    assert.isUndefined(credentials.tokens);
    assert.equal(credentials.setCalls, 0);
  });
});

class MemoryCredentials {
  appSecret = "secret";
  setCalls = 0;

  constructor(public tokens?: OAuthTokens) {}

  getTokens(): OAuthTokens | undefined {
    return this.tokens ? { ...this.tokens } : undefined;
  }

  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.setCalls++;
    this.tokens = { ...tokens };
  }

  clearTokens(): void {
    this.tokens = undefined;
  }

  getAppSecret(): string | undefined {
    return this.appSecret;
  }

  async setAppSecret(secret: string): Promise<void> {
    this.appSecret = secret;
  }

  clearAppSecret(): void {
    this.appSecret = "";
  }
}

function expiredTokens(): OAuthTokens {
  return {
    accessToken: "expired-access",
    refreshToken: "refresh",
    expiresAt: 0,
    refreshExpiresAt: 100_000,
    scope: "offline_access",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}
