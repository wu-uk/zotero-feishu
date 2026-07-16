import type {
  EquationSource,
  RichBlock,
  TextBlock,
  TextRun,
  TextStyle,
} from "../types";

export interface NoteFragment {
  blocks: RichBlock[];
}

export function noteHtmlToBlocks(
  html: string,
  leadingTitleToOmit = "",
): RichBlock[] {
  return noteHtmlToFragments(html, leadingTitleToOmit).flatMap(
    (fragment) => fragment.blocks,
  );
}

export function noteHtmlToFragments(
  html: string,
  leadingTitleToOmit = "",
): NoteFragment[] {
  const parser = new (Zotero.getMainWindow() as any).DOMParser();
  const document = parser.parseFromString(
    `<body>${html}</body>`,
    "text/html",
  ) as Document;
  const body = document.body;
  if (!body) return [emptyFragment()];
  const root = noteContentRoot(body);
  const leadingTitle = matchingLeadingTitle(root, leadingTitleToOmit);
  const fragments = Array.from(root.childNodes)
    .filter((node): node is Node =>
      Boolean(node && meaningfulNode(node) && node !== leadingTitle),
    )
    .map(nodeToFragment);
  return fragments.length ? fragments : [emptyFragment()];
}

function nodeToFragment(node: Node): NoteFragment {
  const blocks: RichBlock[] = [];
  if (containsImage(node)) {
    appendBlockNode(node, blocks);
    return { blocks };
  }
  if (isOrderedList(node)) {
    const equations: EquationSource[] = [];
    const list = prepareElementForConversion(node as Element, equations);
    return {
      blocks: [
        {
          type: "html",
          content: splitOrderedListItems(list),
          normalizeOrderedListItems: true,
          ...(equations.length ? { equations } : {}),
        },
      ],
    };
  }
  const equations: EquationSource[] = [];
  return {
    blocks: [
      {
        type: "html",
        content: serializeNode(node, equations),
        ...(equations.length ? { equations } : {}),
      },
    ],
  };
}

function emptyFragment(): NoteFragment {
  return {
    blocks: [{ type: "paragraph", runs: [{ text: "(Empty note)" }] }],
  };
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

function matchingLeadingTitle(
  root: HTMLElement,
  title: string,
): Node | undefined {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) return undefined;
  const first = Array.from(root.childNodes).find((node): node is Node =>
    Boolean(node && meaningfulNode(node)),
  );
  if (!first || first.nodeType !== 1) return undefined;
  const element = first as Element;
  if (!/^h[1-6]$/i.test(element.tagName)) return undefined;
  return normalizeTitle(element.textContent || "") === normalizedTitle
    ? first
    : undefined;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsImage(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.matches("img") || Boolean(element.querySelector("img"));
}

function isOrderedList(node: Node): boolean {
  return (
    node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "ol"
  );
}

function splitOrderedListItems(element: Element): string {
  const items = Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  if (!items.length) return String(element.outerHTML);

  let sequence = integerAttribute(element, "start") ?? 1;
  return items
    .map((item) => {
      sequence = integerAttribute(item, "value") ?? sequence;
      const list = element.cloneNode(false) as Element;
      list.setAttribute("start", String(sequence));
      list.appendChild(item.cloneNode(true));
      sequence++;
      return String(list.outerHTML);
    })
    .join("");
}

function serializeNode(node: Node, equations: EquationSource[]): string {
  if (node.nodeType === 1) {
    return String(
      prepareElementForConversion(node as Element, equations).outerHTML,
    );
  }
  return `<p>${escapeHtml(node.textContent || "")}</p>`;
}

function prepareElementForConversion(
  source: Element,
  equations: EquationSource[],
): Element {
  const element = source.cloneNode(true) as Element;
  if (isMathElement(element)) return equationReplacement(element, equations);
  const mathElements = Array.from(
    element.querySelectorAll(".math"),
  ) as Element[];
  mathElements.forEach((math) => {
    math.replaceWith(equationReplacement(math, equations));
  });
  return element;
}

function isMathElement(element: Element): boolean {
  return element.classList.contains("math");
}

function equationReplacement(
  element: Element,
  equations: EquationSource[],
): Element {
  const equation = unwrapMath(element.textContent || "");
  const document = element.ownerDocument;
  if (!document) throw new Error("Zotero math element has no owner document");
  const display = element.tagName.toLowerCase() === "pre";
  const marker = document.createElement(display ? "p" : "span");
  marker.textContent = equationMarker(equations.length);
  equations.push({ content: equation, display });
  return marker;
}

function unwrapMath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function equationMarker(index: number): string {
  return `__ZOTERO_FEISHU_EQUATION_${index}__`;
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

function integerAttribute(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  if (!value || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}
