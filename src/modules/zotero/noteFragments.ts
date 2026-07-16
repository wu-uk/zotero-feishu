export function noteFragmentNodes(
  html: string,
  leadingTitleToOmit = "",
): Node[] {
  const parser = new (Zotero.getMainWindow() as any).DOMParser();
  const document = parser.parseFromString(
    `<body>${html}</body>`,
    "text/html",
  ) as Document;
  const body = document.body;
  if (!body) return [];
  const root = noteContentRoot(body);
  const leadingTitle = matchingLeadingTitle(root, leadingTitleToOmit);
  return Array.from(root.childNodes).filter((node): node is Node =>
    Boolean(node && meaningfulNode(node) && node !== leadingTitle),
  );
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
