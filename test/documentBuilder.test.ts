import { assert } from "chai";
import { noteHtmlToBlocks } from "../src/modules/documentBuilder";
import {
  parseFolderToken,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  requireMediaFileToken,
} from "../src/modules/feishuClient";

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

  it("keeps top-level Zotero images on the local upload path", function () {
    const blocks = noteHtmlToBlocks(
      '<img data-attachment-key="TOP123" alt="top-level">',
    );
    assert.equal(blocks[0].type, "image");
    assert.equal((blocks[0] as any).attachmentKey, "TOP123");
  });

  it("keeps Markdown-equivalent HTML for native Feishu conversion", function () {
    const blocks = noteHtmlToBlocks(
      '<div data-schema-version="9"><h3>Section</h3><ul><li>One<ul><li>Nested</li></ul></li></ul><pre><code>const n = 1;</code></pre><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table></div>',
    );
    assert.lengthOf(blocks, 1);
    assert.equal(blocks[0].type, "html");
    const content = (blocks[0] as any).content;
    assert.include(content, "<h3>Section</h3>");
    assert.include(content, "<ul><li>One<ul><li>Nested</li></ul></li></ul>");
    assert.include(content, "<pre><code>const n = 1;</code></pre>");
    assert.include(content, "<table>");
  });

  it("removes read-only table merge metadata before insertion", function () {
    const source = [
      {
        block_type: 31,
        table: { property: { row_size: 2, merge_info: [{ row_span: 2 }] } },
      },
    ];
    const [prepared] = prepareConvertedBlocks(source);
    assert.notProperty(prepared.table.property, "merge_info");
    assert.property(source[0].table.property, "merge_info");
  });

  it("requires the uploaded image file token", function () {
    assert.equal(
      requireMediaFileToken({ file_token: "boxcnImage123" }),
      "boxcnImage123",
    );
    assert.throws(
      () => requireMediaFileToken({}),
      "Feishu did not return an image file token",
    );
  });

  it("maps metadata callouts to a Feishu container and child blocks", function () {
    const prepared = prepareCalloutBlock(
      {
        type: "callout",
        backgroundColor: 14,
        emojiId: "star",
        children: [
          {
            type: "paragraph",
            runs: [
              { text: "Authors: ", style: { bold: true } },
              { text: "Example Author" },
            ],
          },
        ],
      },
      "metadata_callout",
    );
    assert.deepEqual(prepared.children_id, ["metadata_callout"]);
    assert.deepInclude(prepared.descendants[0], {
      block_id: "metadata_callout",
      block_type: 19,
      callout: { background_color: 14, emoji_id: "star" },
      children: ["metadata_callout_child_0"],
    });
    assert.equal(prepared.descendants[1].block_id, "metadata_callout_child_0");
    assert.equal(prepared.descendants[1].block_type, 2);
    assert.equal(
      prepared.descendants[1].text.elements[0].text_run.content,
      "Authors: ",
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
