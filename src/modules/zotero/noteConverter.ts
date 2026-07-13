import type { RichBlock, TextBlock, TextRun, TextStyle } from "../types";

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
  if (tag === "img") {
    appendImageBlock(element, blocks);
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
      appendImageBlock(childElement, blocks);
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

function appendImageBlock(element: Element, blocks: RichBlock[]): void {
  const attachmentKey = element.getAttribute("data-attachment-key") || "";
  blocks.push({
    type: "image",
    attachmentKey,
    alt: element.getAttribute("alt") || attachmentKey || "embedded image",
    width: numberAttribute(element, "width"),
    height: numberAttribute(element, "height"),
  });
}

function safeLink(value: string | null): string | undefined {
  if (!value) return undefined;
  return /^(https?:|mailto:)/i.test(value) ? value : undefined;
}

function numberAttribute(element: Element, name: string): number | undefined {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
