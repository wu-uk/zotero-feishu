import type { DocumentModel, RichBlock, TextBlock, TextRun } from "./types";
import { noteHtmlToBlocks } from "./zotero/noteConverter";
import {
  collectSource,
  type PdfAttachmentSource,
  type SourceData,
} from "./zotero/sourceCollector";

const DOCUMENT_SCHEMA_VERSION = 9;

export { noteHtmlToBlocks } from "./zotero/noteConverter";

export async function buildDocument(item: Zotero.Item): Promise<DocumentModel> {
  const source = await collectSource(item);
  const sourceHash = await hashSource(source);
  const blocks: RichBlock[] = [
    {
      type: "quote",
      runs: [
        { text: "Zotero source: ", style: { bold: true } },
        { text: source.key },
        { text: ` | Synced: ${new Date().toISOString()}` },
      ],
    },
    { type: "divider" },
    {
      type: "callout",
      backgroundColor: 14,
      emojiId: "star",
      children: [
        metadataLine("Authors", source.authors),
        metadataLine("Year", source.year),
        metadataLine("Type", source.itemType),
        metadataLine("Publication", source.publication),
        metadataLine("DOI", source.doi, doiLink(source.doi)),
        metadataLine("URL", source.url, source.url),
        metadataLine("Tags", source.tags.join(", ")),
      ],
    },
  ];

  if (source.abstract) {
    blocks.push(
      { type: "heading1", runs: [{ text: "Abstract" }] },
      { type: "paragraph", runs: [{ text: source.abstract }] },
    );
  }

  blocks.push({ type: "heading1", runs: [{ text: "Notes" }] });
  if (!source.notes.length) {
    blocks.push({ type: "paragraph", runs: [{ text: "No child notes." }] });
  }
  source.notes.forEach((note, index) => {
    blocks.push({
      type: "heading2",
      runs: [{ text: note.title || `Note ${index + 1}` }],
    });
    blocks.push(...noteHtmlToBlocks(note.html));
  });

  if (source.pdfs.length) {
    blocks.push(...pdfAttachmentsToBlocks(source.pdfs));
  }

  return {
    title: `[${source.year || "n.d."}] ${source.title || "Untitled"}`,
    blocks,
    sourceHash,
  };
}

export function pdfAttachmentsToBlocks(
  pdfs: Array<Pick<PdfAttachmentSource, "key" | "name">>,
): RichBlock[] {
  if (!pdfs.length) return [];
  return [
    { type: "heading1", runs: [{ text: "PDF Attachments" }] },
    ...pdfs.map((pdf) => ({
      type: "file" as const,
      attachmentKey: pdf.key,
      name: pdf.name,
    })),
  ];
}

function metadataLine(label: string, value: string, link?: string): TextBlock {
  const runs: TextRun[] = [{ text: `${label}: `, style: { bold: true } }];
  runs.push({ text: value || "-", ...(link ? { style: { link } } : {}) });
  return { type: "paragraph", runs };
}

function doiLink(doi: string): string | undefined {
  return doi
    ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`
    : undefined;
}

async function hashSource(source: SourceData): Promise<string> {
  const win = Zotero.getMainWindow() as any;
  const bytes = new win.TextEncoder().encode(
    JSON.stringify({ schemaVersion: DOCUMENT_SCHEMA_VERSION, source }),
  );
  const digest = new Uint8Array(
    await win.crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
