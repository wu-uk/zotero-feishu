import { assert } from "chai";
import { FeishuClient } from "../src/modules/feishuClient";
import type { OAuthService } from "../src/modules/oauthService";
import { FeishuError, FeishuTransport } from "../src/modules/feishu/transport";
import type { DocumentSection, SyncedSection } from "../src/modules/types";

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

  it("replaces only the changed document section", async function () {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const rootBlocks = [
      { block_id: "metadata-block" },
      { block_id: "old-note-block" },
      { block_id: "pdf-block" },
    ];
    Zotero.HTTP.request = (async (method, url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ method, url, body });
      if (method === "GET" && url.endsWith("/children?page_size=500")) {
        return response({ items: rootBlocks, has_more: false });
      }
      if (method === "DELETE" && url.includes("/batch_delete")) {
        rootBlocks.splice(body.start_index, body.end_index - body.start_index);
        return response({ document_revision_id: 2 });
      }
      if (method === "POST" && url.includes("/children?")) {
        const created = body.children.map((block: any, index: number) => ({
          ...block,
          block_id: `new-note-block-${index}`,
        }));
        rootBlocks.splice(body.index, 0, ...created);
        return response({ children: created });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof Zotero.HTTP.request;

    const previous: SyncedSection[] = [
      syncedSection("metadata", "metadata-v1", ["metadata-block"]),
      syncedSection("note:A", "note-v1", ["old-note-block"]),
      syncedSection("pdfs", "pdfs-v1", ["pdf-block"]),
    ];
    const desired: DocumentSection[] = [
      documentSection("metadata", "metadata-v1"),
      documentSection("note:A", "note-v2"),
      documentSection("pdfs", "pdfs-v1"),
    ];
    const result = await new FeishuClient(
      createOAuth("user-token"),
    ).syncDocumentSections("document-id", desired, previous, async () => "");

    assert.isFalse(result.rebuilt);
    assert.deepEqual(
      rootBlocks.map((block) => block.block_id),
      ["metadata-block", "new-note-block-0", "pdf-block"],
    );
    assert.deepEqual(result.sections, [
      previous[0],
      syncedSection("note:A", "note-v2", ["new-note-block-0"]),
      previous[2],
    ]);
    assert.lengthOf(
      requests.filter((request) => request.method === "DELETE"),
      1,
    );
    assert.deepInclude(
      requests.find((request) => request.method === "DELETE")?.body,
      { start_index: 1, end_index: 2 },
    );
    assert.equal(
      requests.find((request) => request.method === "POST")?.body.index,
      1,
    );
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

function response(data: Record<string, unknown>): any {
  return { status: 200, response: { code: 0, data } };
}

function documentSection(key: string, sourceHash: string): DocumentSection {
  return {
    key,
    sourceHash,
    blocks: [{ type: "paragraph", runs: [{ text: key }] }],
  };
}

function syncedSection(
  key: string,
  sourceHash: string,
  blockIds: string[],
): SyncedSection {
  return { key, sourceHash, blockIds };
}
