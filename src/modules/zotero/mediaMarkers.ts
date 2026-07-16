import type { EmbeddedImageSource } from "../types";

export function replaceImageElements(
  source: Element,
  images: EmbeddedImageSource[],
): Element {
  if (source.tagName.toLowerCase() === "img") {
    return imageReplacement(source, images);
  }
  (Array.from(source.querySelectorAll("img")) as Element[]).forEach((image) => {
    image.replaceWith(imageReplacement(image, images));
  });
  return source;
}

function imageReplacement(
  element: Element,
  images: EmbeddedImageSource[],
): Element {
  const document = element.ownerDocument;
  if (!document) throw new Error("Zotero image has no owner document");
  const attachmentKey = element.getAttribute("data-attachment-key") || "";
  const marker = `__ZOTERO_FEISHU_IMAGE_${images.length}__`;
  images.push({
    marker,
    attachmentKey,
    alt: element.getAttribute("alt") || attachmentKey || "embedded image",
    width: numberAttribute(element, "width"),
    height: numberAttribute(element, "height"),
  });
  const replacement = document.createElement("span");
  replacement.textContent = marker;
  return replacement;
}

function numberAttribute(element: Element, name: string): number | undefined {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
