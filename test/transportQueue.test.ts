import { assert } from "chai";
import type { OAuthService } from "../src/modules/oauthService";
import { FeishuTransport } from "../src/modules/feishu/transport";

describe("Feishu write queue", function () {
  it("releases concurrent document writes one interval at a time", async function () {
    const originalNow = Date.now;
    const originalDelay = Zotero.Promise.delay;
    let now = 0;
    const delays: number[] = [];
    Date.now = () => now;
    Zotero.Promise.delay = (async (milliseconds: number) => {
      delays.push(milliseconds);
      now += milliseconds;
    }) as typeof Zotero.Promise.delay;
    try {
      const transport = new FeishuTransport({
        getAccessToken: async () => "token",
      } as OAuthService);
      await Promise.all([
        transport.waitForDocumentWrite(),
        transport.waitForDocumentWrite(),
        transport.waitForDocumentWrite(),
      ]);
    } finally {
      Date.now = originalNow;
      Zotero.Promise.delay = originalDelay;
    }

    assert.deepEqual(delays, [350, 350]);
  });
});
