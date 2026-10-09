import { detect, rebuild } from "../analysis/detect";
import type { DetectMode, DetectOptions, Detection, Segment, SegmentKind, SegmentSpec, SignalKind } from "../analysis/model";
import { DEFAULT_OPTIONS } from "../analysis/model";
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
  KIND_LABEL,
  mmss,
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
  error?: string;
}

const DEMOS: Array<{
  id: string;
  label: string;
  workout: WorkoutName;
  lapMode: LapMode;
  synth?: Partial<SynthOptions>;
  options?: Partial<DetectOptions>;
}> = [
  { id: "6x800", label: "6 × 800 m track · structured workout", workout: "6x800", lapMode: "workout", synth: { autoPause: true, subSport: "track" } },
  { id: "8x400", label: "8 × 400 m · lap button", workout: "8x400", lapMode: "manual" },
  { id: "pyramid", label: "Pyramid 400–1200 m · no laps", workout: "pyramid", lapMode: "none" },
  { id: "fartlek", label: "Fartlek 8 × 2 min", workout: "fartlek", lapMode: "none" },
  { id: "hills", label: "Hill repeats", workout: "hills", lapMode: "none", synth: { truthAt: "command" }, },
  { id: "12x200", label: "12 × 200 m", workout: "12x200", lapMode: "none" },
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
  };

  // ------------------------------------------------------------------ static shell
  const dropArea = h("div");
  const noticeArea = h("div");
  const activityArea = h("div");
  const toolbarHost = h("div");
  const resultsArea = h("div");
  const fileInput = h("input", { type: "file", accept: ".fit,.FIT", hidden: true, "aria-label": "Choose a Garmin FIT file" });
  activityArea.append(toolbarHost, resultsArea);

  const themeBtn = h("button", { class: "btn small", "aria-label": "Switch between light and dark theme", title: "Switch between light and dark theme" }, "Theme");
  themeBtn.addEventListener("click", cycleTheme);

  const page = h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "top" },
      h("h1", {}, "Interval Analyzer"),
      h("span", { class: "sub" }, "Garmin .fit → reps, rests, pace, distance"),
      h("span", { class: "grow" }),
      h("span", { class: "privacy", title: "The file is decoded and analysed locally by JavaScript in this tab." }, "🔒 Runs in your browser — nothing is uploaded"),
      themeBtn,
    ),
    dropArea,
    noticeArea,
    activityArea,
    h(
      "footer",
      {},
      "Boundaries are the half-way point of each change of pace, found by change-point detection on the 1 Hz speed signal (or taken from the watch's laps). Distances come from the recorded distance curve at those boundaries.",
    ),
    fileInput,
  );
  root.append(page);
  applyStoredTheme();

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
      renderResults();
    },
    onZoom: (z) => {
      state.zoom = z;
      renderResults();
    },
    onMoveBoundary: (index, t) => {
      const d = state.detection!;
      const specs = specsOf(d);
      specs[index - 1] = { ...specs[index - 1], end: t, source: "manual" };
      specs[index] = { ...specs[index], start: t, source: "manual" };
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

  renderDrop();

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
      state.error = (e as Error).message;
      state.loading = false;
      renderDrop();
      renderNotices();
    }
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
      startAnalysis(activity, `${demo.label} (simulated)`, true, demo.options ?? {});
    } catch (e) {
      state.error = (e as Error).message;
      state.loading = false;
      renderDrop();
      renderNotices();
    }
  }

  function startAnalysis(activity: Activity, name: string, isDemo: boolean, optionOverrides: Partial<DetectOptions>) {
    const series = buildSeries(activity);
    state.activity = activity;
    state.series = series;
    state.fileName = name;
    state.isDemo = isDemo;
    state.options = { ...DEFAULT_OPTIONS, ...optionOverrides };
    state.zoom = null;
    state.selected = null;
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
    renderNotices();
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
    const pick = h("button", { class: "btn primary", on: { click: () => fileInput.click() } }, state.activity ? "Open another file…" : "Choose a .fit file");
    if (state.loading) {
      dropArea.append(h("div", { class: "drop" }, h("h2", {}, "Analysing…"), h("p", {}, "Decoding the FIT file and detecting intervals.")));
      return;
    }
    if (state.activity) {
      dropArea.append(
        h(
          "div",
          { class: "drop compact-drop", style: { marginTop: "12px" } },
          pick,
          h("span", { class: "meta", style: { color: "var(--ink-2)", fontSize: "13px" } }, "or drop a file anywhere on the page"),
        ),
      );
      return;
    }
    dropArea.append(
      h(
        "div",
        { class: "drop" },
        h("h2", {}, "Drop a Garmin .fit file here"),
        h(
          "p",
          {},
          "Export the original file from Garmin Connect (activity ⚙ → Export Original) or copy it from the watch's GARMIN/Activity folder. Everything is analysed locally in this page.",
        ),
        h("div", { class: "actions" }, pick),
        h(
          "div",
          { class: "demos" },
          "No file handy? Try a simulated session:",
          h(
            "div",
            { class: "row" },
            ...DEMOS.map((d) => h("button", { class: "btn small", on: { click: () => void loadDemo(d.id) } }, d.label)),
          ),
        ),
      ),
    );
  }

  function renderNotices() {
    clear(noticeArea);
    if (state.error) {
      noticeArea.append(h("div", { class: "notice error", role: "alert" }, state.error));
    }
    const d = state.detection;
    const a = state.activity;
    if (!d || !a) return;
    const isInfo = (n: string) => /trails the distance|reconstructed|derived from distance|^Hilly route|^Laps not used/.test(n);
    const msgs = [...a.warnings, ...d.notes.filter((n) => !isInfo(n))];
    const s = state.series!;
    if (!d.intervalsFound && s.hasAltitude && d.signalUsed === "speed") {
      const alts = Array.from(s.altitude).filter(Number.isFinite);
      if (Math.max(...alts) - Math.min(...alts) > 25) {
        msgs.push("This route has significant elevation change. For hill repeats, switch “Pace type” to Grade-adjusted.");
      }
    }
    if (msgs.length) {
      noticeArea.append(h("div", { class: "notice", role: "status" }, h("ul", { style: { margin: "0", paddingLeft: "18px" } }, ...msgs.map((m) => h("li", {}, m)))));
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
      h("h2", {}, state.fileName ?? "Activity"),
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

    const sensLabel = h("span", { class: "val" }, state.options.sensitivity.toFixed(1));
    const sens = h("input", { type: "range", min: "0.5", max: "2", step: "0.1", value: String(state.options.sensitivity), "aria-label": "Sensitivity" });
    let t: number | undefined;
    sens.addEventListener("input", () => {
      sensLabel.textContent = Number(sens.value).toFixed(1);
      state.options.sensitivity = Number(sens.value);
      window.clearTimeout(t);
      t = window.setTimeout(recompute, 90);
    });

    const numberField = (label: string, key: "minWorkSec" | "minRestSec", min: number, max: number) => {
      const input = h("input", { type: "number", min: String(min), max: String(max), step: "1", value: String(state.options[key]), id: `f-${key}` });
      input.addEventListener("change", () => {
        const v = Math.min(max, Math.max(min, Number(input.value) || min));
        input.value = String(v);
        state.options[key] = v;
        recompute();
      });
      return h("div", { class: "field" }, h("label", { for: `f-${key}` }, label), input);
    };

    const thr = h("input", { type: "text", id: "f-thr", placeholder: "auto", size: "6", inputmode: "numeric", "aria-label": `Work/rest threshold (${sd.unit})` });
    const thrNote = h("span", { class: "val" });
    const syncThreshold = () => {
      const cur = speedDisplay(a.sport, state.units);
      if (state.options.thresholdSpeed !== undefined) thr.value = cur.format(state.options.thresholdSpeed);
      else thr.value = "";
      const dthr = state.detection?.threshold;
      thr.placeholder = dthr !== undefined ? cur.format(dthr) : "auto";
      thrNote.textContent = state.options.thresholdSpeed === undefined && dthr !== undefined ? "auto" : "";
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
      { class: "toolbar", role: "region", "aria-label": "Detection settings" },
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Source"), segmented<DetectMode>([["auto", "Auto"], ["laps", "Laps"], ["signal", "Pace signal"]], () => state.options.mode, (v) => { state.options.mode = v; recompute(); })),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Pace type"), segmented<SignalKind>([["auto", "Auto"], ["speed", sd.isPace ? "Pace" : "Speed"], ["gap", "Grade-adjusted"]], () => state.options.signal, (v) => { state.options.signal = v; recompute(); })),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Sensitivity"), h("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, sens, sensLabel)),
      numberField("Min rep (s)", "minWorkSec", 3, 600),
      numberField("Min rest (s)", "minRestSec", 2, 600),
      h("div", { class: "field" }, h("label", { for: "f-thr" }, `Work/rest threshold (${sd.unit})`), h("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, thr, thrNote)),
      h("div", { class: "field check" }, snap, h("label", { for: "f-snap", title: "Move boundaries of laps you pressed by hand to the nearest real change of pace. Structured-workout laps are never moved." }, "Snap laps to pace")),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Units"), segmented<Units>([["metric", "km"], ["imperial", "mi"]], () => state.units, (v) => { state.units = v; renderToolbarUnits(); renderResults(); })),
    );
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
    const info = d.notes.filter((n) => /trails the distance|reconstructed|derived from distance|^Hilly route|^Laps not used/.test(n));
    resultsArea.append(
      h(
        "div",
        { class: "mode-note" },
        `Detected from ${d.modeUsed === "laps" ? "device laps" : "the pace signal"}. ${d.modeReason}${d.signalUsed === "gap" ? " Hard/easy was judged on grade-adjusted pace (effort on flat ground), not raw pace." : ""}${state.edited ? " · Edited manually." : ""}`,
        info.length ? ` ${info.join(" ")}` : "",
      ),
    );

    // hero
    if (d.intervalsFound && sum) {
      resultsArea.append(
        h(
          "section",
          { class: "hero", "aria-label": "Detected workout" },
          h("div", { class: "kicker" }, "Detected workout"),
          h("div", { class: "big" }, sum.structure),
          h("div", { class: "sub" }, `${sum.repCount} work intervals · ${fmtDistance(sum.totalWorkDistance, state.units)} hard running in ${duration(sum.totalWorkTime)}`),
        ),
        tilesFor(d, sd),
      );
    } else {
      resultsArea.append(
        h(
          "section",
          { class: "hero" },
          h("div", { class: "kicker" }, "Detected workout"),
          h("div", { class: "big" }, "No intervals detected"),
          h("div", { class: "sub" }, d.notes.slice(-1)[0] ?? "The pace never alternated between hard and easy efforts. Try raising the sensitivity or lowering the minimum rep length."),
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
      showThreshold: d.signalUsed === "speed",
    });
  }

  function timelineCard(d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const legend = h(
      "div",
      { class: "legend" },
      h("span", { class: "item" }, h("span", { class: "key-line", style: { color: "var(--muted)" } }), `Recorded ${sd.label.toLowerCase()}`),
      h("span", { class: "item" }, h("span", { class: "key-line", style: { color: "var(--s1)" } }), "Interval average"),
      h("span", { class: "item" }, h("span", { class: "key-wash", style: { background: "var(--band-work)" } }), "Work interval"),
    );
    const xSeg = h("div", { class: "seg" });
    for (const [v, label] of [["time", "Time"], ["distance", "Distance"]] as Array<[XMode, string]>) {
      xSeg.append(h("button", { type: "button", "aria-pressed": state.xMode === v ? "true" : "false", on: { click: () => { state.xMode = v; state.zoom = null; renderResults(); } } }, label));
    }
    const head = h(
      "div",
      { class: "card-head" },
      h("h3", {}, "Timeline"),
      legend,
      h("span", { class: "grow" }),
      state.zoom ? h("button", { class: "btn small", on: { click: () => { state.zoom = null; renderResults(); } } }, "Reset zoom") : null,
      xSeg,
    );
    const card = h("section", { class: "card" }, head, chart.el);
    const sel = state.selected !== null ? d.segments[state.selected] : undefined;
    if (sel) card.append(inspector(sel, d, sd));
    card.append(
      h("div", { class: "hint" }, "Click a block or row to inspect it · drag the handles on the strip to move a boundary · drag across the chart to zoom, double-click to reset · arrow keys step through the data."),
    );
    return card;
  }

  function inspector(sg: Segment, d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const repNo = sg.kind === "work" ? d.reps.findIndex((r) => r.id === sg.id) + 1 : 0;
    const kind = h("select", { "aria-label": "Segment type" });
    for (const k of ["work", "rest", "warmup", "cooldown"] as SegmentKind[]) {
      const o = h("option", { value: k }, KIND_LABEL[k]);
      if (k === sg.kind) o.selected = true;
      kind.append(o);
    }
    kind.addEventListener("change", () => setKind(sg.id, kind.value as SegmentKind));
    return h(
      "div",
      { class: "inspector" },
      h("span", { class: "title" }, sg.kind === "work" ? `Rep ${repNo}` : KIND_LABEL[sg.kind]),
      h("span", {}, `${duration(sg.start, 1)} → ${duration(sg.end, 1)} · ${duration(sg.duration, 1)} · ${fmtDistance(sg.distance, state.units)} · ${sd.formatWithUnit(sg.avgSpeed)}`),
      h("span", { class: "grow" }),
      kind,
      h("button", { class: "btn small", disabled: sg.id === 0, on: { click: () => merge(sg.id, -1) } }, "Merge ← prev"),
      h("button", { class: "btn small", disabled: sg.id === d.segments.length - 1, on: { click: () => merge(sg.id, 1) } }, "Merge next →"),
      h("button", { class: "btn small", disabled: sg.duration < 2 * MIN_SPLIT, on: { click: () => split(sg.id) } }, "Split in half"),
      state.edited ? h("button", { class: "btn small", on: { click: recompute } }, "Reset edits") : null,
    );
  }

  function tilesFor(d: Detection, sd: ReturnType<typeof speedDisplay>) {
    const sum = d.summary!;
    const reps = d.reps;
    const main = sum.mainSet;
    const tiles: Array<{ label: string; value: string; unit?: string; note?: string }> = [];
    tiles.push({
      label: `Average work ${sd.label.toLowerCase()}`,
      value: sd.format(sum.avgWorkSpeed),
      unit: sd.unit,
      note: main.length > 1 && sum.fastestRep !== undefined && sum.slowestRep !== undefined ? `Fastest ${sd.format(reps[sum.fastestRep].avgSpeed)} · slowest ${sd.format(reps[sum.slowestRep].avgSpeed)}` : undefined,
    });
    if (main.length > 1) {
      tiles.push({
        label: `${sd.label} variability`,
        value: `${sum.paceCvPct.toFixed(1)} %`,
        note: sd.isPace ? `${Math.round(sum.paceSpreadSecPerKm)} s/km between fastest and slowest${main.length < reps.length ? ` (main set of ${main.length})` : ""}` : undefined,
      });
      const slower = sum.firstToLastPct < 0;
      tiles.push({
        label: "First → last rep",
        value: `${Math.abs(sum.firstToLastPct).toFixed(1)} % ${slower ? "slower" : "faster"}`,
        note: main.length >= 3 && sd.isPace ? `Trend ${signed(sum.paceTrendSecPerKmPerRep, 1)} s/km per rep` : undefined,
      });
    }
    if (sum.medianRestTime > 0) {
      tiles.push({
        label: "Typical rest",
        value: duration(Math.round(sum.medianRestTime)),
        note: Number.isFinite(sum.workRestRatio) ? `Work : rest = ${sum.workRestRatio.toFixed(1)} : 1` : undefined,
      });
    }
    if (sum.avgWorkHr !== undefined) {
      tiles.push({
        label: "Heart rate in work",
        value: bpm(sum.avgWorkHr),
        unit: "bpm avg",
        note: `Peak ${bpm(sum.peakHr)}${sum.hrDrift !== undefined ? ` · drift ${signed(sum.hrDrift, 0)} bpm` : ""}`,
      });
    }
    if (sum.avgHrRecovery !== undefined) {
      tiles.push({ label: "HR recovery per rest", value: num(sum.avgHrRecovery, 0), unit: "bpm", note: "End of rep → end of rest" });
    }
    return h(
      "div",
      { class: "tiles" },
      ...tiles.map((t) =>
        h(
          "div",
          { class: "tile" },
          h("div", { class: "label" }, t.label),
          h("div", { class: "value" }, t.value, t.unit ? h("small", {}, t.unit) : null),
          t.note ? h("div", { class: "note" }, t.note) : null,
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
      { key: "kind", label: "Type", cell: () => "" },
      { key: "start", label: "Start", cell: (s) => duration(s.start) },
      { key: "time", label: "Time", cell: (s) => duration(s.duration, s.kind === "work" && s.duration < 120 ? 1 : 0) },
      { key: "dist", label: `Distance (${bigDistance ? (units === "imperial" ? "mi" : "km") : distanceUnitShort(0, units)})`, cell: (s) => (bigDistance ? (units === "imperial" ? (s.distance / 1609.344).toFixed(2) : (s.distance / 1000).toFixed(2)) : distanceShort(s.distance, units)) },
      { key: "pace", label: `${sd.label} (${sd.unit})`, cell: (s) => sd.format(s.avgSpeed) },
    ];
    if (series.hasAltitude) cols.push({ key: "gap", label: `GAP (${sd.unit})`, cell: (s) => (sd.isPace && s.kind !== "rest" ? sd.format(s.avgGapSpeed) : "–") });
    cols.push({ key: "max", label: "Best 5 s", cell: (s) => (s.kind === "work" ? sd.format(s.maxSpeed) : "–") });
    if (series.hasHr) {
      cols.push({ key: "hr", label: "HR avg", cell: (s) => bpm(s.avgHr) });
      cols.push({ key: "hrmax", label: "HR max", cell: (s) => bpm(s.maxHr) });
      cols.push({ key: "hrend", label: "HR end", cell: (s) => bpm(s.hrEnd) });
    }
    if (series.hasCadence) cols.push({ key: "cad", label: "Cadence", cell: (s) => num(s.avgCadence, 0) });
    if (series.hasPower) cols.push({ key: "pwr", label: "Power", cell: (s) => num(s.avgPower, 0) });
    if (series.hasAltitude) cols.push({ key: "elev", label: units === "imperial" ? "Elev ↑/↓ ft" : "Elev ↑/↓ m", cell: (s) => (s.elevGain === undefined ? "–" : `${Math.round((s.elevGain) * (units === "imperial" ? 3.28084 : 1))}/${Math.round((s.elevLoss ?? 0) * (units === "imperial" ? 3.28084 : 1))}`) });
    cols.push({ key: "fade", label: "Fade %", cell: (s) => (s.kind === "work" && s.fadePct !== undefined ? signed(s.fadePct, 1) : "–") });
    if (anyTarget) cols.push({ key: "tgt", label: `Target (${sd.unit})`, cell: (s) => (s.targetSpeedLow !== undefined && s.targetSpeedHigh !== undefined ? `${sd.format(s.targetSpeedHigh)}–${sd.format(s.targetSpeedLow)}` : "–") });

    const thead = h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", { class: c.key === "kind" ? "l" : "", scope: "col", title: HEADER_TITLES[c.key] }, c.label))));
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
              h("span", { class: "kind" }, h("span", { class: `dot ${sg.kind === "work" ? "" : "other"}` }), KIND_LABEL[sg.kind]),
              sg.source === "manual" ? h("span", { class: "tag" }, "edited") : sg.snapShift !== undefined ? h("span", { class: "tag", title: `Lap boundary moved ${signed(sg.snapShift, 1)} s` }, "snapped") : null,
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
            else if (c.key === "kind") text = `${s.repCount} work reps`;
            else if (c.key === "time") text = duration(s.totalWorkTime);
            else if (c.key === "dist") text = bigDistance ? (units === "imperial" ? (s.totalWorkDistance / 1609.344).toFixed(2) : (s.totalWorkDistance / 1000).toFixed(2)) : distanceShort(s.totalWorkDistance, units);
            else if (c.key === "pace") text = sd.format(s.avgWorkSpeed);
            else if (c.key === "hr") text = bpm(s.avgWorkHr);
            else if (c.key === "hrmax") text = bpm(s.peakHr);
            return h("td", { class: c.key === "kind" ? "l" : "", style: { fontWeight: "600" } }, text);
          }),
        ),
      );
    }

    const showToggle = h("div", { class: "seg" });
    for (const [v, label] of [[true, "All segments"], [false, "Reps only"]] as Array<[boolean, string]>) {
      showToggle.append(h("button", { type: "button", "aria-pressed": state.tableAll === v ? "true" : "false", on: { click: () => { state.tableAll = v; renderResults(); } } }, label));
    }
    const head = h(
      "div",
      { class: "card-head" },
      h("h3", {}, "Intervals"),
      h("span", { class: "grow" }),
      showToggle,
      h("div", { class: "table-actions" }, h("button", { class: "btn small", on: { click: () => download(d) } }, "Download CSV")),
    );
    return h("section", { class: "card" }, head, h("div", { class: "table-scroll" }, h("table", { class: "segments" }, h("caption", { class: "sr-only", style: { position: "absolute", left: "-9999px" } }, "Detected segments with pace, distance and heart rate"), thead, tbody, tfoot)));
  }

  function download(d: Detection) {
    const a = state.activity!;
    const csv = segmentsToCsv(d, state.series!, a.sport);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: `${(state.fileName ?? "intervals").replace(/\.fit$/i, "").replace(/[^\w.-]+/g, "_")}-intervals.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

const MIN_SPLIT = 5;

const HEADER_TITLES: Record<string, string> = {
  gap: "Grade-adjusted pace: what the effort is worth on flat ground",
  max: "Fastest 5 seconds inside the rep",
  hrend: "Mean heart rate over the last 5 seconds",
  fade: "Positive = slowed down in the second half, negative = sped up",
};

function sportLabel(a: Activity): string {
  const sub = a.subSport && a.subSport !== "generic" ? ` (${a.subSport})` : "";
  return `${a.sport}${sub}`;
}

/** "3:35", "215" or "3.5" → m/s. Pace sports read m:ss per unit, others a plain speed. */
function parseThreshold(text: string, isPace: boolean, units: Units): number | undefined {
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

void mmss;
