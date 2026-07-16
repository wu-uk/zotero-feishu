import { assert } from "chai";
import { remoteHashForSection } from "../src/modules/feishu/documentSnapshot";
import type { DocumentSnapshot } from "../src/modules/types";

describe("document snapshots", function () {
  it("ignores volatile IDs and comments but detects managed content edits", async function () {
    const first = snapshot("root-a", "child-a", "Hello", ["comment-a"]);
    const second = snapshot("root-b", "child-b", "Hello", ["comment-b"]);
    const edited = snapshot("root-b", "child-b", "Changed", []);

    const firstHash = await remoteHashForSection(first, {
      blockIds: ["root-a"],
    });
    const secondHash = await remoteHashForSection(second, {
      blockIds: ["root-b"],
    });
    const editedHash = await remoteHashForSection(edited, {
      blockIds: ["root-b"],
    });

    assert.equal(firstHash, secondHash);
    assert.notEqual(firstHash, editedHash);
  });
});

function snapshot(
  rootId: string,
  childId: string,
  content: string,
  commentIds: string[],
): DocumentSnapshot {
  return {
    documentId: "document-id",
    title: "Example",
    revisionId: 99,
    rootBlockIds: [rootId],
    blocks: [
      {
        block_id: rootId,
        block_type: 19,
        parent_id: "document-id",
        comment_ids: commentIds,
        callout: { background_color: 14 },
        children: [childId],
      },
      {
        block_id: childId,
        block_type: 2,
        parent_id: rootId,
        comment_ids: commentIds,
        text: {
          elements: [
            {
              text_run: {
                content,
                text_element_style: {},
              },
            },
          ],
        },
      },
    ],
  };
}
