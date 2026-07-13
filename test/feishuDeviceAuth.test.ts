import { assert } from "chai";
import {
  FEISHU_SCOPES,
  FeishuDeviceAuth,
  InvalidFeishuApplicationError,
  MissingAppPermissionsError,
  type AuthorizationProgress,
  type DeviceAuthDependencies,
} from "../src/modules/feishuDeviceAuth";

interface RequestRecord {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

describe("FeishuDeviceAuth", function () {
  it("registers a PersonalAgent app through the browser flow", async function () {
    const fake = createFake([
      ok({
        device_code: "registration-code",
        user_code: "user-code",
        interval: 1,
        expires_in: 30,
      }),
      ok({ error: "authorization_pending" }),
      ok({ error: "slow_down" }),
      ok({ client_id: "cli_test", client_secret: "secret" }),
    ]);
    const progress: AuthorizationProgress[] = [];
    const app = await new FeishuDeviceAuth(
      fake.dependencies,
    ).registerApplication((value) => progress.push(value));

    assert.deepEqual(app, { appId: "cli_test", appSecret: "secret" });
    assert.include(fake.requests[0].body, "archetype=PersonalAgent");
    assert.include(fake.requests[0].body, "auth_method=client_secret");
    assert.lengthOf(fake.launchedUrls, 1);
    assert.include(fake.launchedUrls[0], "user_code=user-code");
    assert.include(fake.launchedUrls[0], "from=cli");
    assert.deepEqual(
      progress.map((value) => value.phase),
      ["registering_app", "waiting_app_registration"],
    );
  });

  it("opens permission settings when the token lacks scopes", async function () {
    const fake = createFake([
      ok({
        device_code: "login-code",
        verification_uri_complete: "https://example.test/authorize",
        interval: 1,
        expires_in: 30,
      }),
      ok({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: FEISHU_SCOPES.filter(
          (scope) => scope !== "docx:document.block:convert",
        ).join(" "),
      }),
    ]);
    const progress: AuthorizationProgress[] = [];
    let caught: unknown;
    try {
      await new FeishuDeviceAuth(fake.dependencies).authorizeUser(
        { appId: "cli_test", appSecret: "secret" },
        (value) => progress.push(value),
      );
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, MissingAppPermissionsError);
    assert.lengthOf(fake.launchedUrls, 2);
    assert.equal(
      fake.launchedUrls[1],
      "https://open.feishu.cn/app/cli_test/auth?" +
        "q=docx%3Adocument.block%3Aconvert",
    );
    assert.deepEqual(progress.at(-1)?.missingScopes, [
      "docx:document.block:convert",
    ]);
  });

  it("opens permission settings when device authorization rejects a scope", async function () {
    const fake = createFake([
      {
        status: 400,
        data: {
          error: "invalid_scope",
          error_description:
            "Application has not enabled docx:document.block:convert",
        },
      },
    ]);
    let caught: unknown;
    try {
      await new FeishuDeviceAuth(fake.dependencies).authorizeUser({
        appId: "cli_test",
        appSecret: "secret",
      });
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, MissingAppPermissionsError);
    assert.deepEqual((caught as MissingAppPermissionsError).missingScopes, [
      "docx:document.block:convert",
    ]);
    assert.lengthOf(fake.launchedUrls, 1);
    assert.include(fake.launchedUrls[0], "/app/cli_test/auth?");
  });

  it("authorizes a user with the exact plugin scopes", async function () {
    const fake = createFake([
      ok({
        device_code: "login-code",
        verification_uri_complete: "https://example.test/authorize",
        interval: 1,
        expires_in: 30,
      }),
      ok({ error: "authorization_pending" }),
      ok({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: FEISHU_SCOPES.join(" "),
      }),
    ]);
    const token = await new FeishuDeviceAuth(fake.dependencies).authorizeUser({
      appId: "cli_test",
      appSecret: "secret",
    });

    assert.equal(token.access_token, "access");
    assert.equal(fake.launchedUrls[0], "https://example.test/authorize");
    assert.include(
      decodeURIComponent(fake.requests[0].body || ""),
      `scope=${FEISHU_SCOPES.join(" ")}`,
    );
    assert.match(fake.requests[0].headers?.Authorization || "", /^Basic /);
  });

  it("reports an authorization denial without retrying", async function () {
    const fake = createFake([
      ok({
        device_code: "login-code",
        verification_uri: "https://example.test/authorize",
        interval: 1,
        expires_in: 30,
      }),
      { status: 400, data: { error: "access_denied" } },
    ]);

    let caught: unknown;
    try {
      await new FeishuDeviceAuth(fake.dependencies).authorizeUser({
        appId: "cli_test",
        appSecret: "secret",
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, Error);
    assert.include((caught as Error).message, "denied");
    assert.lengthOf(fake.requests, 2);
  });

  it("identifies a deleted or disabled configured app", async function () {
    const fake = createFake([
      {
        status: 400,
        data: {
          error: "invalid_client",
          error_description: "The Specified app is not enabled",
        },
      },
    ]);

    let caught: unknown;
    try {
      await new FeishuDeviceAuth(fake.dependencies).authorizeUser({
        appId: "cli_deleted",
        appSecret: "secret",
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, InvalidFeishuApplicationError);
    assert.lengthOf(fake.launchedUrls, 0);
  });

  it("identifies a configured app disabled during token polling", async function () {
    const fake = createFake([
      ok({
        device_code: "login-code",
        verification_uri: "https://example.test/authorize",
        interval: 1,
        expires_in: 30,
      }),
      {
        status: 400,
        data: {
          error: "invalid_client",
          error_description: "The Specified app is not enabled",
        },
      },
    ]);

    let caught: unknown;
    try {
      await new FeishuDeviceAuth(fake.dependencies).authorizeUser({
        appId: "cli_deleted",
        appSecret: "secret",
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, InvalidFeishuApplicationError);
    assert.lengthOf(fake.launchedUrls, 1);
  });
});

function createFake(responses: Array<{ status: number; data: any }>): {
  dependencies: DeviceAuthDependencies;
  requests: RequestRecord[];
  launchedUrls: string[];
} {
  let now = 0;
  const requests: RequestRecord[] = [];
  const launchedUrls: string[] = [];
  return {
    dependencies: {
      request: async (method, url, options) => {
        requests.push({ method, url, ...options });
        const response = responses.shift();
        if (!response) throw new Error(`Unexpected request: ${url}`);
        return response;
      },
      delay: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
      launchURL: (url) => launchedUrls.push(url),
    },
    requests,
    launchedUrls,
  };
}

function ok(data: any): { status: number; data: any } {
  return { status: 200, data };
}
