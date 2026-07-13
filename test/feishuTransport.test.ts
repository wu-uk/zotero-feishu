import { assert } from "chai";
import { FeishuClient } from "../src/modules/feishuClient";
import type { OAuthService } from "../src/modules/oauthService";
import { FeishuError, FeishuTransport } from "../src/modules/feishu/transport";

describe("Feishu transport", function () {
  let originalRequest: typeof Zotero.HTTP.request;

  before(function () {
    originalRequest = Zotero.HTTP.request;
  });

  afterEach(function () {
    Zotero.HTTP.request = originalRequest;
  });

  it("adds user authorization and returns response data", async function () {
    let receivedMethod = "";
    let receivedUrl = "";
    let receivedOptions: any;
    Zotero.HTTP.request = (async (method, url, options) => {
      receivedMethod = method;
      receivedUrl = url;
      receivedOptions = options;
      return {
        status: 200,
        response: { code: 0, data: { document_id: "docx123" } },
      } as any;
    }) as typeof Zotero.HTTP.request;

    const transport = createTransport("user-token");
    const data = await transport.request("POST", "/docx/v1/documents", {
      title: "Example",
    });

    assert.equal(receivedMethod, "POST");
    assert.equal(
      receivedUrl,
      "https://open.feishu.cn/open-apis/docx/v1/documents",
    );
    assert.equal(receivedOptions.headers.Authorization, "Bearer user-token");
    assert.equal(receivedOptions.body, JSON.stringify({ title: "Example" }));
    assert.deepEqual(data, { document_id: "docx123" });
  });

  it("converts Feishu API failures into structured errors", async function () {
    Zotero.HTTP.request = (async () =>
      ({
        status: 403,
        response: { code: 99991679, msg: "Unauthorized" },
      }) as any) as typeof Zotero.HTTP.request;

    let caught: unknown;
    try {
      await createTransport("expired-token").request(
        "GET",
        "/docx/v1/documents/docx123",
      );
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, FeishuError);
    assert.equal((caught as FeishuError).message, "Unauthorized");
    assert.equal((caught as FeishuError).status, 403);
    assert.equal((caught as FeishuError).code, 99991679);
  });

  it("loads the current user's display name", async function () {
    let receivedUrl = "";
    Zotero.HTTP.request = (async (_method, url) => {
      receivedUrl = url;
      return {
        status: 200,
        response: {
          code: 0,
          data: { name: "Example User", open_id: "ou_example" },
        },
      } as any;
    }) as typeof Zotero.HTTP.request;

    const user = await new FeishuClient(
      createOAuth("user-token"),
    ).getCurrentUser();

    assert.equal(
      receivedUrl,
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
    );
    assert.deepEqual(user, {
      name: "Example User",
      openId: "ou_example",
    });
  });
});

function createTransport(accessToken: string): FeishuTransport {
  return new FeishuTransport(createOAuth(accessToken));
}

function createOAuth(accessToken: string): OAuthService {
  return {
    getAccessToken: async () => accessToken,
  } as OAuthService;
}
