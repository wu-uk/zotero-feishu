import { assert } from "chai";
import { noteHtmlToBlocks } from "../src/modules/documentBuilder";
import { parseFolderToken } from "../src/modules/feishuClient";

describe("Zotero Feishu Sync helpers", function () {
  it("preserves common rich text and embedded image order", function () {
    const blocks = noteHtmlToBlocks(
      '<p>Hello <strong>world</strong><img data-attachment-key="ABC123" alt="figure">after</p>',
    );

    assert.deepEqual(
      blocks.map((block) => block.type),
      ["paragraph", "image", "paragraph"],
    );
    assert.deepInclude((blocks[0] as any).runs[1], {
      text: "world",
      style: { bold: true },
    });
    assert.equal((blocks[1] as any).attachmentKey, "ABC123");
    assert.equal((blocks[2] as any).runs[0].text, "after");
  });

  it("flattens lists into ordered block types", function () {
    const blocks = noteHtmlToBlocks(
      "<ul><li>One</li><li>Two</li></ul><ol><li>Three</li></ol>",
    );
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["bullet", "bullet", "ordered"],
    );
  });

  it("accepts raw tokens and folder URLs", function () {
    assert.equal(parseFolderToken("fldcnABC_123"), "fldcnABC_123");
    assert.equal(
      parseFolderToken("https://example.feishu.cn/drive/folder/fldcnABC_123"),
      "fldcnABC_123",
    );
  });

  it("rejects malformed values", function () {
    assert.throws(() => parseFolderToken("not a folder token"));
  });
});
