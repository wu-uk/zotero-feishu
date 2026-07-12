import type {
  DocumentModel,
  RichBlock,
  TextBlock,
  TextRun,
  TextStyle,
} from "./types";

const DOCUMENT_SCHEMA_VERSION = 7;

interface SourceData {
  key: string;
  title: string;
  year: string;
  itemType: string;
  authors: string;
  publication: string;
  doi: string;
  url: string;
  abstract: string;
  tags: string[];
  notes: Array<{ title: string; html: string }>;
}

export async function buildDocument(item: Zotero.Item): Promise<DocumentModel> {
  const source = collectSource(item);
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

  return {
    title: `[${source.year || "n.d."}] ${source.title || "Untitled"}`,
    blocks,
    sourceHash,
  };
}

function collectSource(item: Zotero.Item): SourceData {
  const notes = item.getNotes().map((id: number, index: number) => {
    const note = Zotero.Items.get(id);
    const html = note?.getNote() || "";
    const title =
      typeof (note as any)?.getNoteTitle === "function"
        ? (note as any).getNoteTitle()
        : `Note ${index + 1}`;
    return { title: String(title || `Note ${index + 1}`), html };
  });
  const date = field(item, "date");
  const year = date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[1] || "";
  const publication =
    field(item, "publicationTitle") || field(item, "publisher") || "";
  const creators = item.getCreators() as Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  return {
    key: item.key,
    title: field(item, "title"),
    year,
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    authors: creators
      .map(
        (creator) =>
          creator.name ||
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      )
      .filter(Boolean)
      .join(", "),
    publication,
    doi: field(item, "DOI"),
    url: field(item, "url"),
    abstract: field(item, "abstractNote"),
    tags: item.getTags().map((tag: { tag: string }) => tag.tag),
    notes,
  };
}

function field(item: Zotero.Item, name: string): string {
  const value = item.getField(name as any, false, true);
  return value ? String(value) : "";
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

export function noteHtmlToBlocks(html: string): RichBlock[] {
  const parser = new (Zotero.getMainWindow() as any).DOMParser();
  const document = parser.parseFromString(
    `<body>${html}</body>`,
    "text/html",
  ) as Document;
  const blocks: RichBlock[] = [];
  const body = document.body;
  if (!body) return [{ type: "paragraph", runs: [{ text: "(Empty note)" }] }];
  const root = noteContentRoot(body);
  let convertibleHtml = "";
  const flushConvertibleHtml = () => {
    if (convertibleHtml.trim()) {
      blocks.push({ type: "html", content: convertibleHtml });
    }
    convertibleHtml = "";
  };
  Array.from(root.childNodes).forEach((node) => {
    if (!node || !meaningfulNode(node)) return;
    if (containsImage(node)) {
      flushConvertibleHtml();
      appendBlockNode(node, blocks);
      return;
    }
    convertibleHtml += serializeNode(node);
  });
  flushConvertibleHtml();
  return blocks.length
    ? blocks
    : [{ type: "paragraph", runs: [{ text: "(Empty note)" }] }];
}

function noteContentRoot(body: HTMLElement): HTMLElement {
  const children = Array.from(body.children);
  if (
    children.length === 1 &&
    children[0].tagName.toLowerCase() === "div" &&
    children[0].hasAttribute("data-schema-version")
  ) {
    return children[0] as HTMLElement;
  }
  return body;
}

function meaningfulNode(node: Node): boolean {
  return node.nodeType === 1 || Boolean(node.textContent?.trim());
}

function containsImage(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.matches("img") || Boolean(element.querySelector("img"));
}

function serializeNode(node: Node): string {
  if (node.nodeType === 1) return String((node as Element).outerHTML);
  return `<p>${escapeHtml(node.textContent || "")}</p>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!,
  );
}

function appendBlockNode(node: Node, blocks: RichBlock[]): void {
  if (node.nodeType === 3) {
    const text = node.textContent?.trim();
    if (text) blocks.push({ type: "paragraph", runs: [{ text }] });
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "div" || tag === "section" || tag === "article") {
    Array.from(element.childNodes).forEach((child) => {
      if (child) appendBlockNode(child, blocks);
    });
    return;
  }
  if (tag === "hr") {
    blocks.push({ type: "divider" });
    return;
  }
  if (tag === "ul" || tag === "ol") {
    Array.from(element.children).forEach((child) => {
      if (child.tagName.toLowerCase() === "li") {
        appendInlineBlock(child, tag === "ul" ? "bullet" : "ordered", blocks);
      }
    });
    return;
  }
  const type: RichBlock["type"] =
    tag === "h1"
      ? "heading1"
      : tag === "h2"
        ? "heading2"
        : tag === "h3"
          ? "heading3"
          : tag === "h4"
            ? "heading4"
            : tag === "h5"
              ? "heading5"
              : tag === "h6"
                ? "heading6"
                : tag === "blockquote"
                  ? "quote"
                  : tag === "pre"
                    ? "code"
                    : "paragraph";
  appendInlineBlock(element, type as TextBlockType, blocks);
}

type TextBlockType = TextBlock["type"];

function appendInlineBlock(
  element: Element,
  type: TextBlockType,
  blocks: RichBlock[],
): void {
  let runs: TextRun[] = [];
  const flush = () => {
    if (runs.some((run) => run.text.trim())) blocks.push({ type, runs });
    runs = [];
  };
  const walk = (node: Node, style: TextStyle = {}) => {
    if (node.nodeType === 3) {
      if (node.textContent) runs.push({ text: node.textContent, style });
      return;
    }
    if (node.nodeType !== 1) return;
    const childElement = node as Element;
    const tag = childElement.tagName.toLowerCase();
    if (tag === "img") {
      flush();
      const attachmentKey =
        childElement.getAttribute("data-attachment-key") || "";
      blocks.push({
        type: "image",
        attachmentKey,
        alt:
          childElement.getAttribute("alt") || attachmentKey || "embedded image",
        width: numberAttribute(childElement, "width"),
        height: numberAttribute(childElement, "height"),
      });
      return;
    }
    if (tag === "br") {
      runs.push({ text: "\n", style });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      Array.from(childElement.children).forEach((child) => {
        if (child.tagName.toLowerCase() === "li") {
          appendInlineBlock(child, tag === "ul" ? "bullet" : "ordered", blocks);
        }
      });
      return;
    }
    const next: TextStyle = { ...style };
    if (tag === "strong" || tag === "b") next.bold = true;
    if (tag === "em" || tag === "i") next.italic = true;
    if (tag === "s" || tag === "strike" || tag === "del")
      next.strikethrough = true;
    if (tag === "u") next.underline = true;
    if (tag === "code") next.inlineCode = true;
    if (tag === "a") next.link = safeLink(childElement.getAttribute("href"));
    Array.from(childElement.childNodes).forEach((child) => {
      if (child) walk(child, next);
    });
  };
  Array.from(element.childNodes).forEach((node) => {
    if (node) walk(node);
  });
  flush();
}

function safeLink(value: string | null): string | undefined {
  if (!value) return undefined;
  return /^(https?:|mailto:)/i.test(value) ? value : undefined;
}

function numberAttribute(element: Element, name: string): number | undefined {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
