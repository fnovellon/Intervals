/** Tiny DOM helpers. Text is always inserted as text nodes, never as HTML. */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { on?: Record<string, EventListener> };

function apply(el: Element, attrs: Attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "on") {
      for (const [ev, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(ev, fn);
    } else if (key === "class") {
      el.setAttribute("class", String(value));
    } else if (key === "style" && typeof value === "object") {
      Object.assign((el as HTMLElement).style, value);
    } else if (key === "value" && el instanceof HTMLInputElement) {
      el.value = String(value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
