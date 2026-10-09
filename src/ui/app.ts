import { detect, rebuild } from "../analysis/detect";
import { structureText } from "../analysis/summary";
import { AppError, getLocale, LOCALES, msg, nf, onLocaleChange, pct, renderMsg, setLocale, t, tn, type Key, type Locale, type Msg } from "../i18n";
import type { DetectMode, DetectOptions, Detection, PaceBasis, Segment, SegmentKind, SegmentSpec, SignalKind } from "../analysis/model";
import { DEFAULT_OPTIONS, EDGE_PRESETS } from "../analysis/model";
import { buildSeries, type Series } from "../analysis/timeseries";
import { parseFit } from "../fit/parse";
import type { Activity } from "../fit/types";
import { encodeFit, synthesize, WORKOUTS, type LapMode, type SynthOptions, type WorkoutName } from "../sample/synth";
import { TimelineChart, type XMode } from "./chart";
import { clear, h } from "./dom";
import {
  bpm,
  dateLabel,
  distance as fmtDistance,
  distanceShort,
  distanceUnitShort,
  duration,
  kindLabel,
  num,
  signed,
  speedDisplay,
  type Units,
} from "./format";
import { segmentsToCsv } from "./csv";

interface State {
  activity?: Activity;
  series?: Series;
  detection?: Detection;
  fileName?: string;
  isDemo: boolean;
  options: DetectOptions;
  units: Units;
  xMode: XMode;
  zoom: [number, number] | null;
  selected: number | null;
  tableAll: boolean;
  edited: boolean;
  loading: boolean;
  error?: Msg;
  /** Set for built-in simulated sessions so the name follows the language. */
  demoId?: string;
  /** The next click on the chart moves this edge of this segment. */
  placing: { id: number; edge: "start" | "end" } | null;
}

const DEMOS: Array<{
  id: string;
  workout: WorkoutName;
  lapMode: LapMode;
  synth?: Partial<SynthOptions>;
  options?: Partial<DetectOptions>;
}> = [
  { id: "6x800", workout: "6x800", lapMode: "workout", synth: { autoPause: true, subSport: "track" } },
  { id: "8x400", workout: "8x400", lapMode: "manual" },
  { id: "pyramid", workout: "pyramid", lapMode: "none" },
  { id: "fartlek", workout: "fartlek", lapMode: "none" },
  { id: "hills", workout: "hills", lapMode: "none", synth: { truthAt: "command" }, },
  { id: "12x200", workout: "12x200", lapMode: "none" },
];

export function mountApp(root: HTMLElement) {
  const state: State = {
    isDemo: false,
    options: { ...DEFAULT_OPTIONS },
    units: "metric",
    xMode: "time",
    zoom: null,
    selected: null,
    tableAll: true,
    edited: false,
    loading: false,
    placing: null,
  };

  // ------------------------------------------------------------------ static shell
  const dropArea = h("div");
  const noticeArea = h("div");
  const activityArea = h("div");
  const toolbarHost = h("div");
  const resultsArea = h("div");
  const fileInput = h("input", { type: "file", accept: ".fit,.FIT", hidden: true });
  const headerHost = h("header", { class: "top" });
  const footerHost = h("footer");
  activityArea.append(toolbarHost, resultsArea);

  const page = h("div", { class: "page" }, headerHost, dropArea, noticeArea, activityArea, footerHost, fileInput);
  root.append(page);
  applyStoredTheme();

  function renderShell() {
    document.documentElement.lang = getLocale();
    document.title = t("app.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("app.description"));
    fileInput.setAttribute("aria-label", t("drop.fileAria"));
    clear(headerHost);
    const themeBtn = h("button", { class: "btn small", "aria-label": t("app.themeAria"), title: t("app.themeAria") }, t("app.theme"));
    themeBtn.addEventListener("click", cycleTheme);
    const lang = h("div", { class: "seg", role: "group", "aria-label": t("app.langAria") });
    for (const l of LOCALES) {
      lang.append(
        h("button", { type: "button", lang: l, "aria-pressed": getLocale() === l ? "true" : "false", on: { click: () => setLocale(l as Locale) } }, l.toUpperCase()),
      );
    }
    headerHost.append(
      h("h1", {}, t("app.title")),
      h("span", { class: "sub" }, t("app.tagline")),
      h("span", { class: "grow" }),
      h("span", { class: "privacy", title: t("app.privacyTitle") }, `🔒 ${t("app.privacy")}`),
      lang,
      themeBtn,
    );
    clear(footerHost);
    footerHost.append(t("app.footer"));
  }

  /** Everything that contains words: runs at start and whenever the language changes. */
  function renderAll() {
    renderShell();
    renderDrop();
    renderNotices();
    if (state.activity) {
      renderToolbar();
      renderResults();
    }
  }
  onLocaleChange(renderAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelPlacing();
  });

  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
    fileInput.value = "";
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropArea.firstElementChild?.classList.add("over");
  });
  window.addEventListener("dragleave", (e) => {
    if ((e as DragEvent).relatedTarget === null) dropArea.firstElementChild?.classList.remove("over");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dropArea.firstElementChild?.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });

  const chart = new TimelineChart({
    onSelect: (id) => {
      state.selected = id;
      state.placing = null;
      renderResults();
    },
    onPlace: (time) => {
      const p = state.placing;
      if (!p) return;
      const index = p.edge === "start" ? p.id : p.id + 1;
      const specs = specsOf(state.detection!);
      if (index < 1 || index >= specs.length) return;
      // keep at least MIN_SEG seconds on either side, like dragging does
      const at = Math.min(specs[index].end - 2, Math.max(specs[index - 1].start + 2, time));
      specs[index - 1] = { ...specs[index - 1], end: at, source: "manual" };
      specs[index] = { ...specs[index], start: at, source: "manual" };
      state.placing = null;
      applyEdit(specs, p.id);
    },
    onZoom: (z) => {
      state.zoom = z;
      renderResults();
    },
    onMoveBoundary: (index, time) => {
      const d = state.detection!;
      const specs = specsOf(d);
      specs[index - 1] = { ...specs[index - 1], end: time, source: "manual" };
      specs[index] = { ...specs[index], start: time, source: "manual" };
      applyEdit(specs);
    },
  });
  let resizeRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (state.detection && chart.el.isConnected) drawChart();
    });
  }).observe(chart.el);

  renderAll();

  // ------------------------------------------------------------------ loading
  async function loadFile(file: File) {
    state.loading = true;
    state.error = undefined;
    renderDrop();
    await new Promise((r) => setTimeout(r, 20)); // let the "Analysing…" state paint
    try {
      const activity = parseFit(await file.arrayBuffer());
      startAnalysis(activity, file.name, false, {});
    } catch (e) {
      failWith(e);
    }
  }

  function failWith(e: unknown) {
    state.error = e instanceof AppError ? e.msg : msg("err.generic", { detail: (e as Error).message });
    state.loading = false;
    renderDrop();
    renderNotices();
  }

  async function loadDemo(id: string) {
    const demo = DEMOS.find((d) => d.id === id)!;
    state.loading = true;
    state.error = undefined;
    renderDrop();
    await new Promise((r) => setTimeout(r, 20));
    try {
      const syn = synthesize({ steps: WORKOUTS[demo.workout](), seed: 21, lapMode: demo.lapMode, ...demo.synth });
      // Exercise the real path: encode to FIT bytes, then decode them.
      const activity = parseFit(encodeFit(syn.activity));
      startAnalysis(activity, "", true, demo.options ?? {}, demo.id);
    } catch (e) {
      failWith(e);
    }
  }

  function startAnalysis(activity: Activity, name: string, isDemo: boolean, optionOverrides: Partial<DetectOptions>, demoId?: string) {
    const series = buildSeries(activity);
    state.activity = activity;
    state.series = series;
    state.fileName = name;
    state.isDemo = isDemo;
    state.demoId = demoId;
    state.options = { ...DEFAULT_OPTIONS, ...optionOverrides };
    state.zoom = null;
    state.selected = null;
    state.placing = null;
    state.edited = false;
    state.loading = false;
    state.error = undefined;
    state.detection = detect(activity, series, state.options);
    renderDrop();
    renderNotices();
    renderToolbar();
    renderResults();
  }

  function recompute() {
    if (!state.activity || !state.series) return;
    state.detection = detect(state.activity, state.series, state.options);
    state.edited = false;
    state.selected = null;
    state.placing = null;
    renderNotices();
    renderResults();
  }

  /** Switch where the paces come from. Only the numbers change, so manual edits are kept. */
  function setPaceBasis(basis: PaceBasis) {
    state.options.paceBasis = basis;
    const d = state.detection;
    if (!d || !state.series) return;
    state.detection = rebuild(state.series, specsOf(d), { ...d, options: { ...d.options, paceBasis: basis } });
    renderResults();
  }

  // ------------------------------------------------------------------ editing
  function specsOf(d: Detection): SegmentSpec[] {
    return d.segments.map((sg) => ({
      start: sg.start,
      end: sg.end,
      kind: sg.kind,
      source: sg.source,
      lapIndex: sg.lapIndex,
      targetSpeedLow: sg.targetSpeedLow,
      targetSpeedHigh: sg.targetSpeedHigh,
    }));
  }

  function applyEdit(specs: SegmentSpec[], select: number | null = state.selected) {
    state.detection = rebuild(state.series!, specs, state.detection!);
    state.edited = true;
    state.selected = select !== null && select < specs.length ? select : null;
    renderResults();
  }

  function startPlacing(id: number, edge: "start" | "end") {
    state.placing = { id, edge };
    renderResults();
    chart.el.scrollIntoView({ block: "nearest" });
  }

  function cancelPlacing() {
    if (!state.placing) return;
    state.placing = null;
    renderResults();
  }

  function setKind(id: number, kind: SegmentKind) {
    const specs = specsOf(state.detection!);
    specs[id] = { ...specs[id], kind, source: "manual" };
    applyEdit(specs);
  }

  function merge(id: number, dir: -1 | 1) {
    const specs = specsOf(state.detection!);
    const other = id + dir;
    if (other < 0 || other >= specs.length) return;
    const lo = Math.min(id, other);
    const merged: SegmentSpec = { ...specs[id], start: specs[lo].start, end: specs[lo + 1].end, source: "manual" };
    specs.splice(lo, 2, merged);
    applyEdit(specs, lo);
  }

  function split(id: number) {
    const specs = specsOf(state.detection!);
    const sp = specs[id];
    if (sp.end - sp.start < 2 * MIN_SPLIT) return;
    const mid = (sp.start + sp.end) / 2;
    specs.splice(id, 1, { ...sp, end: mid, source: "manual" }, { ...sp, start: mid, source: "manual", kind: sp.kind === "work" ? "rest" : sp.kind });
    applyEdit(specs, id);
  }

  // ------------------------------------------------------------------ rendering
  function renderDrop() {
    clear(dropArea);
    const pick = h("button", { class: "btn primary", on: { click: () => fileInput.click() } }, state.activity ? t("drop.another") : t("drop.choose"));
    if (state.loading) {
      dropArea.append(h("div", { class: "drop" }, h("h2", {}, t("drop.analysing")), h("p", {}, t("drop.analysingHelp"))));
      return;
    }
    if (state.activity) {
      dropArea.append(
        h(
          "div",
          { class: "drop compact-drop", style: { marginTop: "12px" } },
          pick,
          h("span", { class: "meta", style: { color: "var(--ink-2)", fontSize: "13px" } }, t("drop.anywhere")),
        ),
      );
      return;
    }
    dropArea.append(
      h(
        "div",
        { class: "drop" },
        h("h2", {}, t("drop.title")),
        h("p", {}, t("drop.help")),
        h("div", { class: "actions" }, pick),
        h(
          "div",
          { class: "demos" },
          t("drop.demos"),
          h(
            "div",
            { class: "row" },
            ...DEMOS.map((d) => h("button", { class: "btn small", on: { click: () => void loadDemo(d.id) } }, t(`demo.${d.id}` as Key))),
          ),
        ),
      ),
    );
  }

  function renderNotices() {
    clear(noticeArea);
    if (state.error) {
      noticeArea.append(h("div", { class: "notice error", role: "alert" }, renderMsg(state.error)));
    }
    const d = state.detection;
    const a = state.activity;
    if (!d || !a) return;
    const msgs: Msg[] = [...a.warnings, ...d.notes.filter((n) => !INFO_NOTES.has(n.key))];
    const s = state.series!;
    if (!d.intervalsFound && s.hasAltitude && d.signalUsed === "speed") {
      const alts = Array.from(s.altitude).filter(Number.isFinite);
      if (Math.max(...alts) - Math.min(...alts) > 25) {
        msgs.push(msg("note.elevationHint"));
      }
    }
    if (msgs.length) {
      noticeArea.append(h("div", { class: "notice", role: "status" }, h("ul", { style: { margin: "0", paddingLeft: "18px" } }, ...msgs.map((m) => h("li", {}, renderMsg(m))))));
    }
  }

  // ---- toolbar (built once per file so sliders keep focus while dragging) ------------
  function renderToolbar() {
    clear(toolbarHost);
    const a = state.activity!;
    const sd = speedDisplay(a.sport, state.units);

    const head = h(
      "div",
      { class: "activity-head" },
      h("h2", {}, state.demoId ? t("demo.simulated", { name: t(`demo.${state.demoId}` as Key) }) : (state.fileName ?? "")),
      h("span", { class: "meta" }, `${dateLabel(a.startTimeMs)} · ${sportLabel(a)} · ${fmtDistance(a.totalDistance, state.units)} · ${duration(a.totalElapsed)}${a.device ? ` · ${a.device}` : ""}`),
    );

    const segmented = <T extends string>(items: Array<[T, string]>, get: () => T, set: (v: T) => void) => {
      const wrap = h("div", { class: "seg", role: "group" });
      const draw = () => {
        clear(wrap);
        for (const [value, label] of items) {
          wrap.append(
            h("button", { type: "button", "aria-pressed": get() === value ? "true" : "false", on: { click: () => { set(value); draw(); } } }, label),
          );
        }
      };
      draw();
      return wrap;
    };

    const sensLabel = h("span", { class: "val" }, nf(state.options.sensitivity, 1));
    const sens = h("input", { type: "range", min: "0.5", max: "2", step: "0.1", value: String(state.options.sensitivity), "aria-label": t("tb.sensitivity") });
    let timer: number | undefined;
    sens.addEventListener("input", () => {
      sensLabel.textContent = nf(Number(sens.value), 1);
      state.options.sensitivity = Number(sens.value);
      window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 90);
    });

    // ---- interval edges: strategy preset + start/end effort + reaction time ---------------------
    const PRESETS = ["beep", "half", "plateau"] as const;
    const matchPreset = () => PRESETS.find((k) => {
      const e = EDGE_PRESETS[k];
      return e.startEffort === state.options.startEffort && e.endEffort === state.options.endEffort && e.reactionSec === state.options.reactionSec;
    }) ?? "custom";
    const edgeSlider = (labelKey: Key, titleKey: Key, key: "startEffort" | "endEffort") => {
      const out = h("span", { class: "val" }, pct(state.options[key] * 100, 0));
      const input = h("input", { type: "range", min: "0.05", max: "0.95", step: "0.05", value: String(state.options[key]), "aria-label": t(labelKey), title: t(titleKey) });
      input.addEventListener("input", () => {
        state.options[key] = Number(input.value);
        out.textContent = pct(state.options[key] * 100, 0);
        edgesChanged();
      });
      const row = h("div", { class: "field", title: t(titleKey) }, h("span", { class: "lbl" }, t(labelKey)), h("span", { class: "row" }, input, out));
      return { row, input, out };
    };
    const startCtl = edgeSlider("tb.startAt", "tb.startTitle", "startEffort");
    const endCtl = edgeSlider("tb.endAt", "tb.endTitle", "endEffort");
    const reaction = h("input", { type: "number", min: "0", max: "3", step: "0.1", value: String(state.options.reactionSec), id: "f-reaction", "aria-label": t("tb.reaction") });
    const preset = h("select", { "aria-label": t("tb.preset"), id: "f-preset" });
    for (const k of [...PRESETS, "custom"] as const) preset.append(h("option", { value: k }, t(`tb.preset.${k}` as Key)));
    const summary = h("summary", { title: t("tb.edgesTitle") });
    const refreshEdges = () => {
      const k = matchPreset();
      preset.value = k;
      startCtl.input.value = String(state.options.startEffort);
      startCtl.out.textContent = pct(state.options.startEffort * 100, 0);
      endCtl.input.value = String(state.options.endEffort);
      endCtl.out.textContent = pct(state.options.endEffort * 100, 0);
      reaction.value = String(state.options.reactionSec);
      summary.textContent = `${t("tb.edges")}${getLocale() === "fr" ? "\u00A0" : ""}: ${t(`tb.preset.${k}` as Key)} (${t("tb.edgeSummary", { start: pct(state.options.startEffort * 100, 0), end: pct(state.options.endEffort * 100, 0), reaction: nf(state.options.reactionSec, 1) })})`;
    };
    let edgeTimer: number | undefined;
    const edgesChanged = () => {
      refreshEdges();
      window.clearTimeout(edgeTimer);
      edgeTimer = window.setTimeout(recompute, 90);
    };
    preset.addEventListener("change", () => {
      if (preset.value === "custom") return;
      Object.assign(state.options, EDGE_PRESETS[preset.value as (typeof PRESETS)[number]]);
      edgesChanged();
    });
    reaction.addEventListener("change", () => {
      state.options.reactionSec = Math.min(3, Math.max(0, Number(reaction.value) || 0));
      edgesChanged();
    });
    const edgesGroup = h(
      "details",
      { class: "edges" },
      summary,
      h(
        "div",
        { class: "edges-body" },
        h("div", { class: "field", title: t("tb.presetTitle") }, h("label", { for: "f-preset" }, t("tb.preset")), preset),
        startCtl.row,
        endCtl.row,
        h("div", { class: "field", title: t("tb.reactionTitle") }, h("label", { for: "f-reaction" }, t("tb.reaction")), reaction),
      ),
    );
    refreshEdges();

    const numberField = (label: string, key: "minWorkSec" | "minRestSec", min: number, max: number, title: string) => {
      const input = h("input", { type: "number", min: String(min), max: String(max), step: "1", value: String(state.options[key]), id: `f-${key}` });
      input.addEventListener("change", () => {
        const v = Math.min(max, Math.max(min, Number(input.value) || min));
        input.value = String(v);
        state.options[key] = v;
        recompute();
      });
      return h("div", { class: "field", title }, h("label", { for: `f-${key}` }, label), input);
    };

    const thr = h("input", { type: "text", id: "f-thr", placeholder: t("tb.autoThreshold"), size: "6", inputmode: "numeric", "aria-label": t("tb.threshold", { unit: sd.unit }) });
    const thrNote = h("span", { class: "val" });
    const syncThreshold = () => {
      const cur = speedDisplay(a.sport, state.units);
      if (state.options.thresholdSpeed !== undefined) thr.value = cur.format(state.options.thresholdSpeed);
      else thr.value = "";
      const dthr = state.detection?.threshold;
      thr.placeholder = dthr !== undefined ? cur.format(dthr) : t("tb.autoThreshold");
      thrNote.textContent = state.options.thresholdSpeed === undefined && dthr !== undefined ? t("tb.autoThreshold") : "";
    };
    thr.addEventListener("change", () => {
      const v = thr.value.trim();
      if (!v) {
        state.options.thresholdSpeed = undefined;
      } else {
        const cur = speedDisplay(a.sport, state.units);
        const parsed = parseThreshold(v, cur.isPace, state.units);
        if (parsed === undefined) {
          thr.value = "";
          return;
        }
        state.options.thresholdSpeed = parsed;
      }
      recompute();
    });
    toolbarSync = syncThreshold;

    const snap = h("input", { type: "checkbox", id: "f-snap" });
    snap.checked = state.options.snapLaps;
    snap.addEventListener("change", () => {
      state.options.snapLaps = snap.checked;
      recompute();
    });

    const bar = h(
      "div",
      { class: "toolbar", role: "region", "aria-label": t("tb.aria") },
      h("div", { class: "field" }, h("span", { class: "lbl" }, t("tb.source")), segmented<DetectMode>([["auto", t("tb.auto")], ["laps", t("tb.laps")], ["signal", t("tb.signal")]], () => state.options.mode, (v) => { state.options.mode = v; recompute(); })),
      h("div", { class: "field" }, h("span", { class: "lbl" }, t("tb.paceType")), segmented<SignalKind>([["auto", t("tb.auto")], ["speed", sd.isPace ? t("tb.pace") : t("tb.speed")], ["gap", t("tb.gap")]], () => state.options.signal, (v) => { state.options.signal = v; recompute(); })),
      ...(state.series?.speedFromDevice
        ? [h("div", { class: "field", title: t("tb.basisTitle") }, h("span", { class: "lbl" }, t("tb.basis")), segmented<PaceBasis>([["distance", t("tb.basisDist")], ["device", t("tb.basisDev")]], () => state.options.paceBasis, setPaceBasis))]
        : []),
      h("div", { class: "field", title: t("tb.sensitivityTitle") }, h("span", { class: "lbl" }, t("tb.sensitivity")), h("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, sens, sensLabel)),
      numberField(t("tb.minRep"), "minWorkSec", 3, 600, t("tb.minRepTitle")),
      numberField(t("tb.minRest"), "minRestSec", 2, 600, t("tb.minRestTitle")),
      h("div", { class: "field", title: t("tb.thresholdTitle") }, h("label", { for: "f-thr" }, t("tb.threshold", { unit: sd.unit })), h("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, thr, thrNote)),
      h("div", { class: "field check" }, snap, h("label", { for: "f-snap", title: t("tb.snapTitle") }, t("tb.snap"))),
      h("div", { class: "field" }, h("span", { class: "lbl" }, t("tb.units")), segmented<Units>([["metric", t("tb.km")], ["imperial", t("tb.mi")]], () => state.units, (v) => { state.units = v; renderToolbarUnits(); renderResults(); })),
    );
    bar.append(edgesGroup);
    toolbarHost.append(head, bar);
    syncThreshold();
  }
  let toolbarSync: () => void = () => {};
  function renderToolbarUnits() {
    // threshold field is unit dependent: rebuild the toolbar (cheap, not during a drag)
    renderToolbar();
  }

  // ---- results -------------------------------------------------------------------------------
  function renderResults() {
    clear(resultsArea);
    const d = state.detection;
    const series = state.series;
    const a = state.activity;
    if (!d || !series || !a) return;
    toolbarSync();
    const sd = speedDisplay(a.sport, state.units);
    const sum = d.summary;

    // modes / explanation
    const noteParts = [
      t(d.modeUsed === "laps" ? "res.fromLaps" : "res.fromSignal", { reason: d.modeReason }),
      d.signalUsed === "gap" ? t("res.gapNote") : "",
      d.options.paceBasis === "device" && series.speedFromDevice ? t("res.basisDevice") : "",
      state.edited ? t("res.edited") : "",
      ...d.notes.filter((n) => INFO_NOTES.has(n.key)).map((n) => renderMsg(n)),
    ].filter(Boolean);
    resultsArea.append(h("div", { class: "mode-note" }, noteParts.join(" ")));

    // hero
    if (d.intervalsFound && sum) {
      resultsArea.append(
        h(
          "section",
          { class: "hero", "aria-label": t("hero.kicker") },
          h("div", { class: "kicker" }, t("hero.kicker")),
          h("div", { class: "big" }, structureText(sum, getLocale())),
          h("div", { class: "sub" }, t("hero.sub", { count: sum.repCount, dist: fmtDistance(sum.totalWorkDistance, state.units), time: duration(sum.totalWorkTime) })),
        ),
        tilesFor(d, sd),
      );
    } else {
      resultsArea.append(
        h(
          "section",
          { class: "hero" },
          h("div", { class: "kicker" }, t("hero.kicker")),
          h("div", { class: "big" }, t("hero.none")),
          h("div", { class: "sub" }, (() => {
            const why = [...d.notes].reverse().find((n) => !INFO_NOTES.has(n.key));
            return why ? renderMsg(why) : t("hero.noneHelp");
          })()),
        ),
      );
    }

    // timeline card
    resultsArea.append(timelineCard(d, sd));
    if (d.segments.length > 1 || d.intervalsFound) resultsArea.append(tableCard(d, sd));
    drawChart();
  }

  function drawChart() {
    const d = state.detection;
    const series = state.series;
    const a = state.activity;
    if (!d || !series || !a) return;
    chart.render({
      series,
      detection: d,
      display: speedDisplay(a.sport, state.units),
      units: state.units,
      xMode: state.xMode,
      zoom: state.zoom,
      selected: state.selected,
      // The threshold is in recorded-speed units: only meaningful when the plotted line is that speed too.
      showThreshold: d.signalUsed === "speed" && (d.options.paceBasis === "device" || !series.speedFromDevice || Math.abs(series.speedRatio - 1) < 0.03),
      placing: state.placing ? { index: state.placing.edge === "start" ? state.placing.id : state.placing.id + 1 } : null,
    });
  }

  function timelineCard(d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const legend = h(
      "div",
      { class: "legend" },
      h("span", { class: "item" }, h("span", { class: "key-line", style: { color: "var(--muted)" } }), t(
        d.options.paceBasis === "distance" && state.series?.speedFromDevice
          ? sd.isPace ? "tl.distancePace" : "tl.distanceSpeed"
          : sd.isPace ? "tl.recordedPace" : "tl.recordedSpeed",
      )),
      h("span", { class: "item" }, h("span", { class: "key-line", style: { color: "var(--s1)" } }), t("tl.avg")),
      h("span", { class: "item" }, h("span", { class: "key-wash", style: { background: "var(--band-work)" } }), t("tl.work")),
    );
    const xSeg = h("div", { class: "seg" });
    for (const [v, label] of [["time", t("tl.time")], ["distance", t("tl.distance")]] as Array<[XMode, string]>) {
      xSeg.append(h("button", { type: "button", "aria-pressed": state.xMode === v ? "true" : "false", on: { click: () => { state.xMode = v; state.zoom = null; renderResults(); } } }, label));
    }
    const head = h(
      "div",
      { class: "card-head" },
      h("h3", {}, t("tl.title")),
      legend,
      h("span", { class: "grow" }),
      state.zoom ? h("button", { class: "btn small", on: { click: () => { state.zoom = null; renderResults(); } } }, t("tl.resetZoom")) : null,
      xSeg,
    );
    const card = h("section", { class: "card" }, head);
    const placing = state.placing ? d.segments[state.placing.id] : undefined;
    if (state.placing && placing) {
      const name = placing.kind === "work" ? t("insp.rep", { n: d.reps.findIndex((r) => r.id === placing.id) + 1 }) : kindLabel(placing.kind);
      card.append(
        h(
          "div",
          { class: "placing-banner", role: "status" },
          h("span", {}, t(state.placing.edge === "start" ? "place.banner.start" : "place.banner.end", { name })),
          h("span", { class: "grow" }),
          h("button", { class: "btn small", on: { click: cancelPlacing } }, t("place.cancel")),
        ),
      );
    }
    card.append(chart.el);
    const sel = state.selected !== null ? d.segments[state.selected] : undefined;
    if (sel) card.append(inspector(sel, d, sd));
    card.append(
      h("div", { class: "hint" }, t("tl.hint")),
    );
    return card;
  }

  function inspector(sg: Segment, d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const repNo = sg.kind === "work" ? d.reps.findIndex((r) => r.id === sg.id) + 1 : 0;
    const kind = h("select", { "aria-label": t("insp.typeAria") });
    for (const k of ["work", "rest", "warmup", "cooldown"] as SegmentKind[]) {
      const o = h("option", { value: k }, kindLabel(k));
      if (k === sg.kind) o.selected = true;
      kind.append(o);
    }
    kind.addEventListener("change", () => setKind(sg.id, kind.value as SegmentKind));

    // The two ways to read a pace can differ a lot (smoothed watch speed, speed and distance from different
    // sensors): show both whenever they do, whichever one the table is using.
    const checks: string[] = [];
    const series = state.series!;
    if (series.speedFromDevice && sg.distSpeed > 0.5 && sg.deviceSpeed > 0.5) {
      const rel = Math.abs(sg.deviceSpeed - sg.distSpeed) / sg.distSpeed;
      if (rel >= PACE_CHECK_DIFF) {
        checks.push(t("insp.basisBoth", { dist: sd.formatWithUnit(sg.distSpeed), dev: sd.formatWithUnit(sg.deviceSpeed), pct: pct(rel * 100, 1) }));
      }
    }
    if (sg.paused >= 1 && sg.paused <= 0.5 * sg.duration) checks.push(t("insp.paused", { n: Math.round(sg.paused) }));

    const bar = h(
      "div",
      { class: "inspector" },
      h("span", { class: "title" }, sg.kind === "work" ? t("insp.rep", { n: repNo }) : kindLabel(sg.kind)),
      h("span", {}, `${duration(sg.start, 1)} → ${duration(sg.end, 1)} · ${duration(sg.duration, 1)} · ${fmtDistance(sg.distance, state.units)} · ${sd.formatWithUnit(sg.avgSpeed)}`),
      h("span", { class: "grow" }),
      kind,
      h("button", { class: "btn small", disabled: sg.id === 0, on: { click: () => startPlacing(sg.id, "start") } }, t("insp.placeStart")),
      h("button", { class: "btn small", disabled: sg.id === d.segments.length - 1, on: { click: () => startPlacing(sg.id, "end") } }, t("insp.placeEnd")),
      h("button", { class: "btn small", disabled: sg.id === 0, on: { click: () => merge(sg.id, -1) } }, t("insp.mergePrev")),
      h("button", { class: "btn small", disabled: sg.id === d.segments.length - 1, on: { click: () => merge(sg.id, 1) } }, t("insp.mergeNext")),
      h("button", { class: "btn small", disabled: sg.duration < 2 * MIN_SPLIT, on: { click: () => split(sg.id) } }, t("insp.split")),
      state.edited ? h("button", { class: "btn small", on: { click: recompute } }, t("insp.reset")) : null,
    );
    return checks.length ? h("div", {}, bar, h("div", { class: "hint insp-check" }, checks.join(" "))) : bar;
  }

  function tilesFor(d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const sum = d.summary!;
    const reps = d.reps;
    const main = sum.mainSet;
    const tiles: Array<{ label: string; value: string; unit?: string; note?: string }> = [];
    tiles.push({
      label: t(sd.isPace ? "tile.avgPace" : "tile.avgSpeed"),
      value: sd.format(sum.avgWorkSpeed),
      unit: sd.unit,
      note: main.length > 1 && sum.fastestRep !== undefined && sum.slowestRep !== undefined ? t("tile.fastSlow", { fast: sd.format(reps[sum.fastestRep].avgSpeed), slow: sd.format(reps[sum.slowestRep].avgSpeed) }) : undefined,
    });
    if (main.length > 1) {
      tiles.push({
        label: t(sd.isPace ? "tile.varPace" : "tile.varSpeed"),
        value: pct(sum.paceCvPct, 1),
        note: sd.isPace
          ? main.length < reps.length
            ? t("tile.spreadMain", { spread: Math.round(sum.paceSpreadSecPerKm), n: main.length })
            : t("tile.spread", { spread: Math.round(sum.paceSpreadSecPerKm) })
          : undefined,
      });
      const slower = sum.firstToLastPct < 0;
      tiles.push({
        label: t("tile.trend"),
        value: t(slower ? "tile.slower" : "tile.faster", { pct: pct(Math.abs(sum.firstToLastPct), 1) }),
        note: main.length >= 3 && sd.isPace ? t("tile.trendNote", { v: signed(sum.paceTrendSecPerKmPerRep, 1) }) : undefined,
      });
    }
    if (sum.medianRestTime > 0) {
      tiles.push({
        label: t("tile.rest"),
        value: duration(Math.round(sum.medianRestTime)),
        note: Number.isFinite(sum.workRestRatio) ? t("tile.ratio", { v: nf(sum.workRestRatio, 1) }) : undefined,
      });
    }
    if (sum.avgWorkHr !== undefined) {
      tiles.push({
        label: t("tile.hr"),
        value: bpm(sum.avgWorkHr),
        unit: t("tile.hrUnit"),
        note: sum.hrDrift !== undefined ? t("tile.hrNoteDrift", { peak: bpm(sum.peakHr), drift: signed(sum.hrDrift, 0) }) : t("tile.hrNote", { peak: bpm(sum.peakHr) }),
      });
    }
    if (sum.avgHrRecovery !== undefined) {
      tiles.push({ label: t("tile.hrRec"), value: num(sum.avgHrRecovery, 0), unit: t("unit.bpm"), note: t("tile.hrRecNote") });
    }
    return h(
      "div",
      { class: "tiles" },
      ...tiles.map((tile) =>
        h(
          "div",
          { class: "tile" },
          h("div", { class: "label" }, tile.label),
          h("div", { class: "value" }, tile.value, tile.unit ? h("small", {}, tile.unit) : null),
          tile.note ? h("div", { class: "note" }, tile.note) : null,
        ),
      ),
    );
  }

  function tableCard(d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const series = state.series!;
    const units = state.units;
    const rows = state.tableAll ? d.segments : d.reps;
    const repNo = new Map<number, number>();
    d.reps.forEach((r, i) => repNo.set(r.id, i + 1));
    const bestId = d.summary && d.summary.fastestRep !== undefined && d.summary.mainSet.length > 1 ? d.reps[d.summary.fastestRep].id : -1;
    const anyTarget = rows.some((r) => r.targetSpeedLow !== undefined);
    const bigDistance = rows.some((r) => r.distance >= 10_000);

    const cols: Array<{ key: string; label: string; cls?: string; cell: (s: Segment) => string }> = [
      { key: "n", label: "#", cell: (s) => (s.kind === "work" ? String(repNo.get(s.id)) : "–") },
      { key: "kind", label: t("col.type"), cell: () => "" },
      { key: "start", label: t("col.start"), cell: (s) => duration(s.start) },
      { key: "time", label: t("col.time"), cell: (s) => duration(s.duration, s.kind === "work" && s.duration < 120 ? 1 : 0) },
      { key: "dist", label: t("col.dist", { unit: bigDistance ? (units === "imperial" ? "mi" : "km") : distanceUnitShort(0, units) }), cell: (s) => (bigDistance ? nf(units === "imperial" ? s.distance / 1609.344 : s.distance / 1000, 2) : distanceShort(s.distance, units)) },
      { key: "pace", label: t("col.pace", { label: sd.label, unit: sd.unit }), cell: (s) => sd.format(s.avgSpeed) },
    ];
    // On flat ground GAP equals the pace, so the column would only repeat it.
    const gapMatters = series.hasAltitude && rows.some((r) => r.avgSpeed > 0.3 && Math.abs(r.avgGapSpeed - r.avgSpeed) / r.avgSpeed >= GAP_VISIBLE_DIFF);
    if (gapMatters) cols.push({ key: "gap", label: t("col.gap", { unit: sd.unit }), cell: (s) => (sd.isPace && s.kind !== "rest" ? sd.format(s.avgGapSpeed) : "–") });
    cols.push({ key: "max", label: t("col.best"), cell: (s) => (s.kind === "work" ? sd.format(s.maxSpeed) : "–") });
    if (series.hasHr) {
      cols.push({ key: "hr", label: t("col.hr"), cell: (s) => bpm(s.avgHr) });
      cols.push({ key: "hrmax", label: t("col.hrmax"), cell: (s) => bpm(s.maxHr) });
      cols.push({ key: "hrend", label: t("col.hrend"), cell: (s) => bpm(s.hrEnd) });
    }
    if (series.hasCadence) cols.push({ key: "cad", label: t("col.cad"), cell: (s) => num(s.avgCadence, 0) });
    if (series.hasPower) cols.push({ key: "pwr", label: t("col.pwr"), cell: (s) => num(s.avgPower, 0) });
    if (series.hasAltitude) cols.push({ key: "elev", label: t("col.elev", { unit: units === "imperial" ? "ft" : "m" }), cell: (s) => (s.elevGain === undefined ? "–" : `${Math.round((s.elevGain) * (units === "imperial" ? 3.28084 : 1))}/${Math.round((s.elevLoss ?? 0) * (units === "imperial" ? 3.28084 : 1))}`) });
    cols.push({ key: "fade", label: t("col.fade"), cell: (s) => (s.kind === "work" && s.fadePct !== undefined ? signed(s.fadePct, 1) : "–") });
    if (anyTarget) cols.push({ key: "tgt", label: t("col.target", { unit: sd.unit }), cell: (s) => (s.targetSpeedLow !== undefined && s.targetSpeedHigh !== undefined ? `${sd.format(s.targetSpeedHigh)}–${sd.format(s.targetSpeedLow)}` : "–") });

    const thead = h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", { class: c.key === "kind" ? "l" : "", scope: "col", title: headerTitle(c.key) }, c.label))));
    const tbody = h("tbody");
    for (const sg of rows) {
      const tr = h("tr", { class: `${state.selected === sg.id ? "sel" : ""} ${sg.kind === "work" ? "" : "dim"}`, tabindex: "0", on: { click: () => { state.selected = state.selected === sg.id ? null : sg.id; renderResults(); } } });
      tr.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
          e.preventDefault();
          state.selected = state.selected === sg.id ? null : sg.id;
          renderResults();
        }
      });
      for (const c of cols) {
        if (c.key === "kind") {
          tr.append(
            h(
              "td",
              { class: "l" },
              h("span", { class: "kind" }, h("span", { class: `dot ${sg.kind === "work" ? "" : "other"}` }), kindLabel(sg.kind)),
              sg.source === "manual" ? h("span", { class: "tag" }, t("tag.edited")) : sg.snapShift !== undefined ? h("span", { class: "tag", title: t("tag.snappedTitle", { v: signed(sg.snapShift, 1) }) }, t("tag.snapped")) : null,
            ),
          );
        } else {
          const td = h("td", { class: c.key === "pace" && sg.id === bestId ? "best" : "" }, c.cell(sg));
          if (c.key === "tgt" && sg.targetSpeedLow !== undefined && sg.targetSpeedHigh !== undefined) {
            const hit = sg.avgSpeed >= sg.targetSpeedLow * 0.99 && sg.avgSpeed <= sg.targetSpeedHigh * 1.01;
            td.append(h("span", { class: hit ? "tgt-hit" : "tag" }, hit ? " ✓" : sg.avgSpeed > sg.targetSpeedHigh ? " ▲" : " ▼"));
          }
          tr.append(td);
        }
      }
      tbody.append(tr);
    }

    const tfoot = h("tfoot");
    if (d.summary) {
      const s = d.summary;
      tfoot.append(
        h(
          "tr",
          {},
          ...cols.map((c) => {
            let text = "";
            if (c.key === "n") text = "Σ";
            else if (c.key === "kind") text = tn("tbl.sumReps", s.repCount);
            else if (c.key === "time") text = duration(s.totalWorkTime);
            else if (c.key === "dist") text = bigDistance ? nf(units === "imperial" ? s.totalWorkDistance / 1609.344 : s.totalWorkDistance / 1000, 2) : distanceShort(s.totalWorkDistance, units);
            else if (c.key === "pace") text = sd.format(s.avgWorkSpeed);
            else if (c.key === "hr") text = bpm(s.avgWorkHr);
            else if (c.key === "hrmax") text = bpm(s.peakHr);
            return h("td", { class: c.key === "kind" ? "l" : "", style: { fontWeight: "600" } }, text);
          }),
        ),
      );
    }

    const showToggle = h("div", { class: "seg" });
    for (const [v, label] of [[true, t("tbl.all")], [false, t("tbl.repsOnly")]] as Array<[boolean, string]>) {
      showToggle.append(h("button", { type: "button", "aria-pressed": state.tableAll === v ? "true" : "false", on: { click: () => { state.tableAll = v; renderResults(); } } }, label));
    }
    const head = h(
      "div",
      { class: "card-head" },
      h("h3", {}, t("tbl.title")),
      h("span", { class: "grow" }),
      showToggle,
      h("div", { class: "table-actions" }, h("button", { class: "btn small", on: { click: () => download(d) } }, t("tbl.csv"))),
    );
    return h("section", { class: "card" }, head, h("div", { class: "table-scroll" }, h("table", { class: "segments" }, h("caption", { class: "sr-only", style: { position: "absolute", left: "-9999px" } }, t("tbl.caption")), thead, tbody, tfoot)));
  }

  function download(d: Detection) {
    const a = state.activity!;
    const csv = segmentsToCsv(d, state.series!, a.sport);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: `${(state.fileName || state.demoId || "intervals").replace(/\.fit$/i, "").replace(/[^\w.-]+/g, "_")}-intervals.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

const MIN_SPLIT = 5;

/** Show the table-vs-chart comparison for a segment when the two paces differ by at least this fraction. */
const PACE_CHECK_DIFF = 0.02;

/** Show the grade-adjusted column only when it differs from the pace by at least this fraction somewhere. */
const GAP_VISIBLE_DIFF = 0.015;

const HEADER_TITLE_KEYS: Record<string, Key> = {
  gap: "col.gap.title",
  max: "col.best.title",
  hrend: "col.hrend.title",
  fade: "col.fade.title",
};
const headerTitle = (col: string): string | undefined => (HEADER_TITLE_KEYS[col] ? t(HEADER_TITLE_KEYS[col]) : undefined);

/** Notes that explain how the numbers were obtained, shown as plain text rather than as a warning. */
const INFO_NOTES = new Set<Key>(["note.lag", "note.distFromSpeed", "note.distFromGps", "note.speedFromDist", "note.hilly", "note.lapsNotUsed"]);

function sportLabel(a: Activity): string {
  const sub = a.subSport && a.subSport !== "generic" ? ` (${a.subSport})` : "";
  return `${a.sport}${sub}`;
}

/** "3:35", "215" or "3.5" → m/s. Pace sports read m:ss per unit, others a plain speed. */
function parseThreshold(input: string, isPace: boolean, units: Units): number | undefined {
  const text = input.replace(",", ".");
  const perUnit = units === "metric" ? 1000 : 1609.344;
  if (isPace) {
    const m = text.match(/^(\d+):([0-5]?\d)$/);
    if (m) {
      const sec = Number(m[1]) * 60 + Number(m[2]);
      return sec > 0 ? perUnit / sec : undefined;
    }
    const n = Number(text);
    return Number.isFinite(n) && n > 60 ? perUnit / n : undefined;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return units === "metric" ? n / 3.6 : (n * 1609.344) / 3600;
}

// ---- theme ------------------------------------------------------------------------------------
function applyStoredTheme() {
  try {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch {
    /* storage unavailable: follow the OS */
  }
}

function cycleTheme() {
  const cur = document.documentElement.dataset.theme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective = cur ?? (prefersDark ? "dark" : "light");
  const next = effective === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* ignore */
  }
}

