import { describe, expect, it } from "vitest";
import { analyseActivity } from "../src/analysis/detect";
import { structureText } from "../src/analysis/summary";
import { en } from "../src/i18n/en";
import { fr } from "../src/i18n/fr";
import { msg, nf, pct, renderMsg, t, tn, type Key } from "../src/i18n";
import { synthesize, WORKOUTS } from "../src/sample/synth";
import { duration, signed } from "../src/ui/format";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translation tables", () => {
  const keys = Object.keys(en) as Key[];

  it("French covers exactly the English keys", () => {
    expect(Object.keys(fr).sort()).toEqual([...keys].sort());
  });

  it("no empty strings", () => {
    for (const k of keys) {
      expect(en[k].trim(), `en ${k}`).not.toBe("");
      expect(fr[k].trim(), `fr ${k}`).not.toBe("");
    }
  });

  it("both languages use the same {placeholders}", () => {
    for (const k of keys) expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
  });

  it("French is actually translated (not a copy of English) for sentences", () => {
    // demo labels such as "12 × 200 m" are legitimately identical in both languages
    const sentences = keys.filter((k) => en[k].split(" ").length >= 4 && !k.startsWith("demo."));
    const same = sentences.filter((k) => fr[k] === en[k]);
    expect(same).toEqual([]);
  });

  it("plural variants exist for every counted key", () => {
    for (const k of keys.filter((x) => x.endsWith(".one"))) expect(keys).toContain(k.replace(/\.one$/, ".other"));
  });
});

describe("t / renderMsg", () => {
  it("fills parameters and nested messages in the requested language", () => {
    const m = msg("note.lapUnavailable", { reason: msg("lap.few") });
    expect(renderMsg(m, "en")).toBe("Lap mode unavailable (The file has fewer than 3 laps.) — used the pace signal instead.");
    expect(renderMsg(m, "fr")).toBe("Mode tours indisponible (Le fichier compte moins de 3 tours.) — le signal d’allure a été utilisé à la place.");
  });

  it("pluralises (French treats 0 and 1 as singular)", () => {
    expect(tn("tbl.sumReps", 1, undefined, "en")).toBe("1 work rep");
    expect(tn("tbl.sumReps", 6, undefined, "en")).toBe("6 work reps");
    expect(tn("tbl.sumReps", 1, undefined, "fr")).toBe("1 effort");
    expect(tn("tbl.sumReps", 6, undefined, "fr")).toBe("6 efforts");
  });

  it("formats numbers with the locale's decimal separator", () => {
    expect(nf(1.25, 1, "en")).toBe("1.3");
    expect(nf(1.2, 1, "fr")).toBe("1,2");
    expect(pct(0.24, 1, "fr")).toBe("0,2 %");
    // default (Node/tests) locale is English
    expect(t("tb.auto")).toBe("Auto");
  });

  it("durations never print an impossible fraction", () => {
    expect(duration(161.04, 1)).toBe("2:41.0");
    expect(duration(160.96, 1)).toBe("2:41.0"); // rounds up with the carry, not "2:411.0"
    expect(duration(159.96, 1)).toBe("2:40.0");
    expect(duration(161.96, 1)).toBe("2:42.0");
    expect(duration(3725)).toBe("1:02:05");
  });

  it("signed numbers use a real minus sign", () => {
    expect(signed(-2.4, 1)).toBe("−2.4");
    expect(signed(3, 0)).toBe("+3");
  });
});

describe("workout description in French", () => {
  const structure = (workout: keyof typeof WORKOUTS, loc: "en" | "fr") => {
    const sum = analyseActivity(synthesize({ steps: WORKOUTS[workout](), seed: 1, lapMode: "none" }).activity, { mode: "signal" }).detection
      .summary!;
    return structureText(sum, loc);
  };

  it("uses 'récup' and keeps units", () => {
    expect(structure("6x800", "en")).toBe("6 × 800 m / 90 s rest");
    expect(structure("6x800", "fr")).toBe("6 × 800 m / 90 s récup");
    expect(structure("fartlek", "fr")).toBe("8 × 2 min / 60 s récup");
  });

  it("uses a decimal comma in sequences", () => {
    expect(structure("pyramid", "en")).toBe("400 m · 800 m · 1.2 km · 800 m · 400 m / 2 min rest");
    expect(structure("pyramid", "fr")).toBe("400 m · 800 m · 1,2 km · 800 m · 400 m / 2 min récup");
  });

  it("English summary.structure is unchanged by the refactor", () => {
    const sum = analyseActivity(synthesize({ steps: WORKOUTS["8x400"](), seed: 1, lapMode: "none" }).activity, { mode: "signal" }).detection
      .summary!;
    expect(sum.structure).toBe("8 × 400 m / 75 s rest");
    expect(structureText(sum, "en")).toBe(sum.structure);
  });
});

describe("numbers inside messages", () => {
  it("are formatted in the reader's language", () => {
    expect(renderMsg(msg("note.lag", { lag: 0.8 }), "en")).toContain("about 0.8 s");
    expect(renderMsg(msg("note.lag", { lag: 0.8 }), "fr")).toContain("environ 0,8 s");
    expect(renderMsg(msg("warn.decoderIssues", { count: 3 }), "fr")).toContain("3 problème(s)");
  });

  it("assembled sentences are grammatical in French", () => {
    const fromLaps = renderMsg(msg("res.fromLaps", { reason: msg("lap.few") }), "fr");
    expect(fromLaps.startsWith("Détecté à partir des tours")).toBe(true);
    expect(renderMsg(msg("res.fromSignal", { reason: msg("sig.reason") }), "fr").startsWith("Détecté à partir du signal")).toBe(true);
  });
});
