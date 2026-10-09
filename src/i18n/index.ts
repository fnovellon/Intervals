import { en } from "./en";
import { fr } from "./fr";

export type Key = keyof typeof en;
export type Locale = "en" | "fr";
export const LOCALES: Locale[] = ["en", "fr"];

/** A translatable message produced by the engine (it has no UI language of its own). */
export interface Msg {
  key: Key;
  params?: Record<string, string | number | Msg>;
}
export const msg = (key: Key, params?: Msg["params"]): Msg => (params ? { key, params } : { key });

type PluralBase = Key extends infer K ? (K extends `${infer B}.one` ? B : never) : never;

const tables: Record<Locale, Record<Key, string>> = { en, fr };

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale, persist = true) {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (persist) {
    try {
      localStorage.setItem("lang", next);
    } catch {
      /* storage unavailable: the choice just won't survive a reload */
    }
  }
  for (const fn of listeners) fn();
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** URL ?lang=, then the saved choice, then the browser language. Node/tests: English. */
export function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (fromUrl === "fr" || fromUrl === "en") return fromUrl;
  } catch {
    /* ignore */
  }
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  const langs = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const l of langs) {
    const base = String(l).toLowerCase().slice(0, 2);
    if (base === "fr") return "fr";
    if (base === "en") return "en";
  }
  return "en";
}

/** Translate a key, filling `{name}` parameters (a parameter may itself be a Msg). */
export function t(key: Key, params?: Msg["params"], loc: Locale = current): string {
  const template = tables[loc][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined) return `{${name}}`;
    if (typeof v === "object") return renderMsg(v, loc);
    // Numbers are formatted here, in the reader's language (0.8 -> "0,8" in French).
    return typeof v === "number" && !Number.isInteger(v) ? nf(v, Math.min(3, String(v).split(".")[1]?.length ?? 0), loc) : String(v);
  });
}

/** `tn("tbl.sumReps", 1)` -> key "tbl.sumReps.one" / ".other" (French: 0 and 1 are singular). */
export function tn(base: PluralBase, n: number, params?: Msg["params"], loc: Locale = current): string {
  const singular = loc === "fr" ? n >= 0 && n < 2 : n === 1;
  return t(`${base}.${singular ? "one" : "other"}` as Key, { n, ...params }, loc);
}

export function renderMsg(m: Msg, loc: Locale = current): string {
  return t(m.key, m.params, loc);
}

/** Error that carries a translatable message; `.message` is the English text. */
export class AppError extends Error {
  constructor(readonly msg: Msg) {
    super(renderMsg(msg, "en"));
    this.name = "AppError";
  }
}

// ---- number formatting ---------------------------------------------------------------------

const formatters = new Map<string, Intl.NumberFormat>();

/** Fixed-decimals number in the given locale (1.2 -> "1,2" in French). */
export function nf(value: number, decimals = 0, loc: Locale = current): string {
  const k = `${loc}:${decimals}`;
  let f = formatters.get(k);
  if (!f) {
    f = new Intl.NumberFormat(loc, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
    formatters.set(k, f);
  }
  return f.format(value);
}

/** "12.3 %" / "12,3 %", with a non-breaking space. */
export function pct(value: number, decimals = 1, loc: Locale = current): string {
  return `${nf(value, decimals, loc)} %`;
}

/** Locale-aware date and time of an epoch-millisecond instant. */
export function dateTimeLabel(ms: number, loc: Locale = current): string {
  return new Date(ms).toLocaleString(loc === "fr" ? "fr-FR" : undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
