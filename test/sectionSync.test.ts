import { assert } from "chai";
import { planSectionSync } from "../src/modules/feishu/sectionSync";
import type { DocumentSection, SyncedSection } from "../src/modules/types";

describe("section sync planning", function () {
  it("replaces only changed sections", function () {
    const previous = [
      synced("metadata", "metadata-v1", ["metadata"]),
      synced("note:A", "note-a-v1", ["note-a-heading", "note-a-body"]),
      synced("pdfs", "pdfs-v1", ["pdf-heading", "pdf-file"]),
    ];
    const desired = [
      section("metadata", "metadata-v1"),
      section("note:A", "note-a-v2"),
      section("pdfs", "pdfs-v1"),
    ];

    assert.deepEqual(
      planSectionSync(
        [
          "metadata",
          "note-a-heading",
          "note-a-body",
          "pdf-heading",
          "pdf-file",
        ],
        previous,
        desired,
      ),
      {
        mode: "incremental",
        deletions: [{ startIndex: 1, endIndex: 3 }],
        retained: [previous[0], previous[2]],
      },
    );
  });

  it("replaces a content-addressed note fragment between retained fragments", function () {
    const previous = [
      synced("note:A:fragment:alpha:1", "alpha", ["alpha-block"]),
      synced("note:A:fragment:beta:1", "beta", ["beta-block"]),
      synced("note:A:fragment:gamma:1", "gamma", ["gamma-block"]),
    ];
    const desired = [
      section("note:A:fragment:alpha:1", "alpha"),
      section("note:A:fragment:beta-v2:1", "beta-v2"),
      section("note:A:fragment:gamma:1", "gamma"),
    ];

    assert.deepEqual(
      planSectionSync(
        ["alpha-block", "beta-block", "gamma-block"],
        previous,
        desired,
      ),
      {
        mode: "incremental",
        deletions: [{ startIndex: 1, endIndex: 2 }],
        retained: [previous[0], previous[2]],
      },
    );
  });

  it("deletes removed sections from the end toward the start", function () {
    const previous = [
      synced("metadata", "metadata-v1", ["metadata"]),
      synced("note:A", "note-a-v1", ["note-a"]),
      synced("note:B", "note-b-v1", ["note-b"]),
    ];

    assert.deepEqual(
      planSectionSync(["metadata", "note-a", "note-b"], previous, [
        section("metadata", "metadata-v1"),
      ]),
      {
        mode: "incremental",
        deletions: [
          { startIndex: 2, endIndex: 3 },
          { startIndex: 1, endIndex: 2 },
        ],
        retained: [previous[0]],
      },
    );
  });

  it("rebuilds when stored block IDs no longer match the document", function () {
    assert.deepEqual(
      planSectionSync(
        ["manually-replaced-block"],
        [synced("metadata", "metadata-v1", ["metadata"])],
        [section("metadata", "metadata-v2")],
      ),
      { mode: "rebuild" },
    );
  });

  it("rebuilds when retained sections were reordered", function () {
    const previous = [
      synced("note:A", "note-a-v1", ["note-a"]),
      synced("note:B", "note-b-v1", ["note-b"]),
    ];
    assert.deepEqual(
      planSectionSync(["note-a", "note-b"], previous, [
        section("note:B", "note-b-v1"),
        section("note:A", "note-a-v1"),
      ]),
      { mode: "rebuild" },
    );
  });
});

function section(key: string, sourceHash: string): DocumentSection {
  return {
    key,
    sourceHash,
    blocks: [{ type: "paragraph", runs: [{ text: key }] }],
  };
}

function synced(
  key: string,
  sourceHash: string,
  blockIds: string[],
): SyncedSection {
  return { key, sourceHash, blockIds };
}
