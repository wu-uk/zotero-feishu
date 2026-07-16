import { assert } from "chai";
import {
  buildNoteSections,
  noteHtmlToBlocks,
  noteHtmlToFragments,
  pdfAttachmentsToBlocks,
} from "../src/modules/documentBuilder";
import {
  createdFileBlockId,
  normalizeConvertedOrderedListItems,
  parseFolderToken,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  requireMediaFileToken,
  restoreConvertedEquations,
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
    assert.lengthOf(blocks, 4);
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["html", "html", "html", "html"],
    );
    assert.equal((blocks[0] as any).content, "<h3>Section</h3>");
    assert.equal(
      (blocks[1] as any).content,
      "<ul><li>One<ul><li>Nested</li></ul></li></ul>",
    );
    assert.equal(
      (blocks[2] as any).content,
      "<pre><code>const n = 1;</code></pre>",
    );
    assert.include((blocks[3] as any).content, "<table>");
  });

  it("omits a leading note heading that duplicates the Zotero title", function () {
    const blocks = noteHtmlToBlocks(
      '<div data-schema-version="9"><h2>Research Questions</h2><p>Body</p></div>',
      "Research Questions",
    );
    assert.lengthOf(blocks, 1);
    assert.equal((blocks[0] as any).content, "<p>Body</p>");

    const different = noteHtmlToBlocks(
      '<div data-schema-version="9"><h2>Overview</h2><p>Body</p></div>',
      "Research Questions",
    );
    assert.lengthOf(different, 2);
    assert.equal((different[0] as any).content, "<h2>Overview</h2>");
  });

  it("marks real ordered items before native Feishu conversion", function () {
    const blocks = noteHtmlToBlocks(
      '<div data-schema-version="9"><p>Before</p><ol><li><p><strong>First</strong></p><p>Body</p></li><li value="4"><p>Fourth</p></li></ol><p>After</p></div>',
    );

    assert.deepEqual(
      blocks.map((block) => block.type),
      ["html", "html", "html"],
    );
    assert.equal((blocks[0] as any).content, "<p>Before</p>");
    assert.isTrue((blocks[1] as any).normalizeOrderedListItems);
    assert.equal(
      (blocks[1] as any).content,
      '<ol start="1"><li><p><strong>First</strong></p><p>Body</p></li></ol><ol start="4"><li value="4"><p>Fourth</p></li></ol>',
    );
    assert.equal((blocks[2] as any).content, "<p>After</p>");
  });

  it("restores Zotero inline and block math as Feishu equations", function () {
    const blocks = noteHtmlToBlocks(
      '<div data-schema-version="9"><p>Given <span class="math">$M$</span> and <span class="math">$X$</span>.</p><pre class="math">$$H^*=\\arg\\max_H r(H)$$</pre></div>',
    );
    assert.lengthOf(blocks, 2);
    const inlineHtml = blocks[0] as any;
    const displayHtml = blocks[1] as any;
    assert.deepEqual(inlineHtml.equations, [
      { content: "M", display: false },
      { content: "X", display: false },
    ]);
    assert.equal(
      inlineHtml.content,
      "<p>Given <span>__ZOTERO_FEISHU_EQUATION_0__</span> and <span>__ZOTERO_FEISHU_EQUATION_1__</span>.</p>",
    );
    assert.deepEqual(displayHtml.equations, [
      { content: "H^*=\\arg\\max_H r(H)", display: true },
    ]);
    assert.equal(displayHtml.content, "<p>__ZOTERO_FEISHU_EQUATION_0__</p>");

    const inlineConverted = restoreConvertedEquations(
      {
        firstLevelBlockIds: ["inline"],
        descendants: [
          textBlock(
            "inline",
            "Given __ZOTERO_FEISHU_EQUATION_0__ and __ZOTERO_FEISHU_EQUATION_1__.",
          ),
        ],
      },
      inlineHtml.equations,
    );
    const displayConverted = restoreConvertedEquations(
      {
        firstLevelBlockIds: ["block"],
        descendants: [textBlock("block", "__ZOTERO_FEISHU_EQUATION_0__")],
      },
      displayHtml.equations,
    );
    const inline = inlineConverted.descendants[0].text.elements;
    assert.deepEqual(
      inline.map((element: any) =>
        element.equation
          ? { equation: element.equation.content }
          : { text: element.text_run.content },
      ),
      [
        { text: "Given " },
        { equation: "M" },
        { text: " and " },
        { equation: "X" },
        { text: "." },
      ],
    );
    assert.equal(
      displayConverted.descendants[0].text.elements[0].equation.content,
      "H^*=\\arg\\max_H r(H)",
    );
    assert.equal(inlineConverted.descendants[0].text.style.align, 1);
    assert.equal(displayConverted.descendants[0].text.style.align, 2);
  });

  it("keeps stable fragment identities across nearby note edits", async function () {
    const original = await buildNoteSections(
      {
        key: "NOTE123",
        title: "Example note",
        html: "<p>Alpha</p><p>Beta</p>",
      },
      0,
    );
    const inserted = await buildNoteSections(
      {
        key: "NOTE123",
        title: "Example note",
        html: "<p>Introduction</p><p>Alpha</p><p>Beta</p>",
      },
      0,
    );
    const changed = await buildNoteSections(
      {
        key: "NOTE123",
        title: "Example note",
        html: "<p>Alpha</p><p>Gamma</p>",
      },
      0,
    );

    assert.equal(original[0].key, "note:NOTE123:heading");
    assert.deepEqual(
      inserted.slice(2).map((section) => section.key),
      original.slice(1).map((section) => section.key),
    );
    assert.equal(changed[1].key, original[1].key);
    assert.notEqual(changed[2].key, original[2].key);
    assert.lengthOf(
      noteHtmlToFragments("<p>Alpha</p><ol><li>One</li></ol><p>Beta</p>"),
      3,
    );
  });

  it("restores paragraphs and nested blocks inside ordered items", function () {
    const converted = normalizeConvertedOrderedListItems({
      firstLevelBlockIds: [
        "first",
        "first-body",
        "second",
        "second-intro",
        "table",
        "second-after",
      ],
      descendants: [
        orderedBlock("first", "1", "First"),
        orderedBlock("first-body", "auto", "Body"),
        orderedBlock("second", "2", "Second"),
        {
          ...orderedBlock("second-intro", "auto", "Intro"),
          children: ["bullet"],
        },
        { block_id: "bullet", block_type: 12, bullet: { elements: [] } },
        {
          block_id: "table",
          block_type: 31,
          table: { property: {} },
          children: ["cell"],
        },
        orderedBlock("second-after", "auto", "After"),
      ],
    });

    assert.deepEqual(converted.firstLevelBlockIds, ["first", "second"]);
    assert.deepEqual((converted.descendants[0] as any).children, [
      "first-body",
    ]);
    assert.deepEqual((converted.descendants[2] as any).children, [
      "second-intro",
      "bullet",
      "table",
      "second-after",
    ]);
    assert.deepInclude(converted.descendants[1], {
      block_id: "first-body",
      block_type: 2,
    });
    assert.equal((converted.descendants[1] as any).text.elements[0], "Body");
    assert.notProperty(
      (converted.descendants[1] as any).text.style,
      "sequence",
    );
    assert.notProperty(converted.descendants[3], "children");
    assert.equal(converted.descendants[5].block_type, 31);
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

  it("requires the uploaded media file token", function () {
    assert.equal(
      requireMediaFileToken({ file_token: "boxcnImage123" }),
      "boxcnImage123",
    );
    assert.throws(
      () => requireMediaFileToken({}),
      "Feishu did not return a media file token",
    );
  });

  it("finds the generated file block behind its Feishu view block", function () {
    assert.equal(
      createdFileBlockId([
        {
          block_id: "view-block",
          block_type: 33,
          children: ["file-block"],
        },
      ]),
      "file-block",
    );
    assert.equal(
      createdFileBlockId([{ block_id: "file-block-direct", block_type: 23 }]),
      "file-block-direct",
    );
    assert.throws(
      () => createdFileBlockId([]),
      "Feishu did not return a file block ID",
    );
  });

  it("places PDF attachments after their section heading", function () {
    const blocks = pdfAttachmentsToBlocks([
      { key: "PDF123", name: "paper.pdf" },
      { key: "PDF456", name: "supplement.pdf" },
    ]);

    assert.deepEqual(
      blocks.map((block) => block.type),
      ["heading1", "file", "file"],
    );
    assert.deepInclude(blocks[1] as any, {
      type: "file",
      attachmentKey: "PDF123",
      name: "paper.pdf",
    });
    assert.deepInclude(blocks[2] as any, {
      type: "file",
      attachmentKey: "PDF456",
      name: "supplement.pdf",
    });
    assert.deepEqual(pdfAttachmentsToBlocks([]), []);
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

function orderedBlock(blockId: string, sequence: string, content: string): any {
  return {
    block_id: blockId,
    block_type: 13,
    ordered: {
      elements: [content],
      style: { align: 1, sequence },
    },
  };
}

function textBlock(blockId: string, content: string): any {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content,
            text_element_style: { bold: false, italic: false },
          },
        },
      ],
      style: { align: 1 },
    },
  };
}
