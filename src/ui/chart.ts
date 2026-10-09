import type { Detection, Segment } from "../analysis/model";
import { distanceAt, paceSeries, quantile, type Series } from "../analysis/timeseries";
import { clear, h, s } from "./dom";
import { getLocale, nf, t } from "../i18n";
import { structureText } from "../analysis/summary";
import { distance as fmtDistance, duration, kindLabel, signed, type SpeedDisplay, type Units } from "./format";

export type XMode = "time" | "distance";

export interface ChartProps {
  series: Series;
  detection: Detection;
  display: SpeedDisplay;
  units: Units;
  xMode: XMode;
  /** Visible time window in seconds, or null for everything. */
  zoom: [number, number] | null;
  selected: number | null;
  /** Draw the work/rest threshold line (only meaningful for plain pace). */
  showThreshold: boolean;
  /** When set, the next click on the chart places boundary `index` there. */
  placing: { index: number } | null;
}

export interface ChartHandlers {
  onSelect(id: number | null): void;
  onZoom(range: [number, number] | null): void;
  /** Boundary between segments[index - 1] and segments[index] moved to `time`. */
  onMoveBoundary(index: number, time: number): void;
  /** The user clicked the chart while placing a boundary. */
  onPlace(time: number): void;
  /** The segment under the pointer changed (null when the pointer left). */
  onHover(id: number | null): void;
}

const M = { left: 60, right: 14, top: 2 };
const STRIP_H = 30;
const STRIP_GAP = 10;
const TITLE_H = 20;
const PANEL_GAP = 12;
const AXIS_H = 26;
const MIN_SEG_S = 2;

interface Panel {
  key: "pace" | "hr" | "ele";
  title: string;
  top: number; // top of plot area
  height: number;
  /** y for a value */
  y(v: number): number;
  ticks: number[];
  fmt(v: number): string;
}

export class TimelineChart {
  readonly el: HTMLElement;
  private svg: SVGSVGElement | null = null;
  private tooltip: HTMLElement;
  private props!: ChartProps;
  private cursor: number | null = null;
  private geom!: {
    width: number;
    plotL: number;
    plotR: number;
    plotTop: number;
    plotBottom: number;
    xd0: number;
    xd1: number;
    t0: number;
    t1: number;
  };
  private panels: Panel[] = [];
  private cross?: SVGGElement;
  /** Highlight layers: behind the lines (bands) and over the strip (outlines). */
  private hlBands?: SVGGElement;
  private hlStrip?: SVGGElement;
  /** Segments to highlight because the pointer is over them / because the page asks for it. */
  private pointerSeg: number | null = null;
  private external: number[] = [];
  /** Boundary whose handle should regain keyboard focus after the next render. */
  private refocus: number | null = null;

  constructor(private handlers: ChartHandlers) {
    this.tooltip = h("div", { class: "tooltip", hidden: true, role: "status" });
    this.el = h("div", {
      class: "chart-wrap",
      tabindex: "0",
      role: "group",
      "aria-label": t("ch.aria"),
      on: { keydown: (e) => this.onKey(e as KeyboardEvent), blur: () => this.hideCursor() },
    });
    this.el.append(this.tooltip);
  }

  /** Current pixel width available to the chart. */
  get width(): number {
    return Math.max(320, Math.floor(this.el.clientWidth));
  }

  render(props: ChartProps) {
    this.props = props;
    this.el.setAttribute("aria-label", t("ch.aria"));
    this.el.toggleAttribute("data-placing", !!props.placing);
    const { series, detection, display } = props;
    const width = this.width;
    const hasHr = series.hasHr;
    const hasEle = series.hasAltitude;

    // ---- x geometry -----------------------------------------------------------------
    const [t0, t1] = props.zoom ?? [0, series.n - 1];
    const xOfT = (t: number) => (props.xMode === "time" ? t : distanceAt(series, t));
    const xd0 = xOfT(t0);
    const xd1 = Math.max(xd0 + 1e-6, xOfT(t1));
    const plotL = M.left;
    const plotR = width - M.right;
    const px = (xv: number) => plotL + ((xv - xd0) / (xd1 - xd0)) * (plotR - plotL);
    const pxT = (t: number) => px(xOfT(t));

    // ---- vertical layout --------------------------------------------------------------
    let y = M.top;
    const stripTop = y;
    y += STRIP_H + STRIP_GAP;
    const plotTop = y;
    const panels: Panel[] = [];
    const addPanel = (key: Panel["key"], title: string, height: number, mk: (top: number, height: number) => Omit<Panel, "key" | "title" | "top" | "height">) => {
      const top = y + TITLE_H;
      panels.push({ key, title, top, height, ...mk(top, height) });
      y = top + height + PANEL_GAP;
    };

    // pace / speed domain from the whole activity so zooming does not rescale
    const movingSpeeds: number[] = [];
    // Ignore standing and the brief ramps through it: they would stretch the axis to 12+ min/km.
    const speedLine = paceSeries(series, detection.options.paceBasis);
    for (let i = 0; i < series.n; i += 2) if (speedLine[i] > 1.5) movingSpeeds.push(speedLine[i]);
    const axisVals = movingSpeeds.map(display.toAxis);
    let lo: number;
    let hi: number;
    if (display.isPace) {
      lo = quantile(axisVals, 0.004) * 0.96;
      hi = quantile(axisVals, 0.98) * 1.06;
    } else {
      lo = 0;
      hi = quantile(axisVals, 0.996) * 1.08;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      lo = 0;
      hi = 1;
    }
    const paceStep = display.isPace ? niceStep((hi - lo) / 5, [10, 15, 30, 60, 120]) : niceStep((hi - lo) / 5, [1, 2, 5, 10]);
    const paceTicks = ticksBetween(lo, hi, paceStep);
    const clampAxis = (v: number) => Math.min(hi, Math.max(lo, v));
    addPanel("pace", `${display.label} (${display.unit})`, 210, (top, height) => ({
      y: (v) => (display.isPace ? top + ((clampAxis(v) - lo) / (hi - lo)) * height : top + height - ((clampAxis(v) - lo) / (hi - lo)) * height),
      ticks: paceTicks,
      fmt: display.formatAxis,
    }));

    if (hasHr) {
      const hrs = Array.from(series.hr).filter(Number.isFinite);
      const hmin = Math.floor((quantile(hrs, 0.002) - 4) / 10) * 10;
      const hmax = Math.ceil((quantile(hrs, 0.998) + 4) / 10) * 10;
      const step = niceStep((hmax - hmin) / 3, [10, 20, 25, 50]);
      addPanel("hr", t("ch.hr"), 96, (top, height) => ({
        y: (v) => top + height - ((Math.min(hmax, Math.max(hmin, v)) - hmin) / (hmax - hmin)) * height,
        ticks: ticksBetween(hmin, hmax, step),
        fmt: (v) => String(Math.round(v)),
      }));
    }
    const eleScale = props.units === "imperial" ? 3.28084 : 1;
    const eleUnit = props.units === "imperial" ? "ft" : "m";
    if (hasEle) {
      const alts = Array.from(series.altitude).filter(Number.isFinite).map((a) => a * eleScale);
      const emin = Math.min(...alts);
      const emax = Math.max(...alts);
      const span = Math.max(emax - emin, 10 * eleScale);
      const lo2 = emin - span * 0.1;
      const hi2 = emin + span * 1.1;
      addPanel("ele", t("ch.ele", { unit: eleUnit }), 60, (top, height) => ({
        y: (v) => top + height - ((v - lo2) / (hi2 - lo2)) * height,
        ticks: ticksBetween(lo2, hi2, niceStep((hi2 - lo2) / 2, [5, 10, 20, 50, 100, 200])),
        fmt: (v) => String(Math.round(v)),
      }));
    }
    const plotBottom = y - PANEL_GAP;
    const axisTop = plotBottom + 6;
    const totalH = axisTop + AXIS_H;
    this.panels = panels;
    this.geom = { width, plotL, plotR, plotTop, plotBottom, xd0, xd1, t0, t1 };

    // ---- svg ------------------------------------------------------------------------------
    const svg = s("svg", {
      class: "chart",
      width,
      height: totalH,
      viewBox: `0 0 ${width} ${totalH}`,
      role: "img",
      "aria-label": this.summaryLabel(),
    });
    const clipId = `clip-${Math.random().toString(36).slice(2, 8)}`;
    svg.append(
      s("defs", {}, s("clipPath", { id: clipId }, s("rect", { x: plotL, y: stripTop, width: plotR - plotL, height: totalH }))),
    );

    const segs = detection.segments;
    const inView = (sg: Segment) => sg.end > t0 && sg.start < t1;

    // bands (behind everything)
    const bands = s("g", { "clip-path": `url(#${clipId})` });
    for (const sg of segs) {
      if (!inView(sg)) continue;
      const sel = props.selected === sg.id;
      const cls = sel ? "band-sel" : sg.kind === "work" ? "band-work" : sg.kind === "warmup" || sg.kind === "cooldown" ? "band-other" : "";
      if (!cls) continue;
      const x0 = Math.max(plotL, pxT(sg.start));
      const x1 = Math.min(plotR, pxT(sg.end));
      bands.append(s("rect", { class: cls, x: x0, y: plotTop, width: Math.max(0, x1 - x0), height: plotBottom - plotTop }));
    }
    svg.append(bands);
    this.hlBands = s("g", { "clip-path": `url(#${clipId})` });
    svg.append(this.hlBands);

    // panels: grid, ticks, titles
    for (const p of panels) {
      const g = s("g");
      g.append(s("text", { class: "panel-title", x: plotL - M.left + 2, y: p.top - 7 }, p.title));
      for (const tv of p.ticks) {
        const yy = p.y(tv);
        if (yy < p.top - 0.5 || yy > p.top + p.height + 0.5) continue;
        g.append(s("line", { class: "grid", x1: plotL, x2: plotR, y1: yy, y2: yy }));
        g.append(s("text", { x: plotL - 8, y: yy + 4, "text-anchor": "end" }, p.fmt(tv)));
      }
      g.append(s("line", { class: "axis", x1: plotL, x2: plotR, y1: p.top + p.height, y2: p.top + p.height }));
      svg.append(g);
    }

    // x axis ticks (drawn under the last panel)
    svg.append(this.xAxis(axisTop, px, props, series));

    // data lines
    const plotW = plotR - plotL;
    const iLo = Math.max(0, Math.floor(t0) - 1);
    const iHi = Math.min(series.n - 1, Math.ceil(t1) + 1);
    const lineGroup = s("g", { "clip-path": `url(#${clipId})` });
    const paceP = panels.find((p) => p.key === "pace")!;
    lineGroup.append(
      s("path", { class: "raw", d: pathOf(bucketize(iLo, iHi, plotW, (i) => xOfT(i), px, (i) => speedLine[i], (v) => paceP.y(display.toAxis(v)))) }),
    );
    // detected segment averages
    const stepsG = s("g");
    const reps = detection.reps;
    const main = detection.summary?.mainSet ?? [];
    const labelled = new Set<number>();
    if (detection.summary && main.length > 1) {
      if (detection.summary.fastestRep !== undefined) labelled.add(reps[detection.summary.fastestRep]?.id);
      if (detection.summary.slowestRep !== undefined) labelled.add(reps[detection.summary.slowestRep]?.id);
    }
    for (const sg of segs) {
      if (!inView(sg) || sg.avgSpeed < 0.5) continue; // standing: nothing to draw
      const xa = Math.max(plotL, pxT(sg.start));
      const xb = Math.min(plotR, pxT(sg.end));
      if (xb - xa < 1) continue;
      const yy = paceP.y(display.toAxis(sg.avgSpeed));
      stepsG.append(s("line", { class: sg.kind === "work" ? "step-work" : "step-other", x1: xa + 1, x2: xb - 1, y1: yy, y2: yy }));
      if (labelled.has(sg.id) && xb - xa > 38) {
        const fast = detection.summary!.fastestRep !== undefined && reps[detection.summary!.fastestRep].id === sg.id;
        stepsG.append(
          s("text", { class: "value-label", x: (xa + xb) / 2, y: yy + (fast ? -7 : 15), "text-anchor": "middle" }, display.format(sg.avgSpeed)),
        );
      }
    }
    lineGroup.append(stepsG);

    if (props.showThreshold && detection.threshold !== undefined) {
      const yt = paceP.y(display.toAxis(detection.threshold));
      lineGroup.append(s("line", { class: "thr-line", x1: plotL, x2: plotR, y1: yt, y2: yt, "stroke-dasharray": "0" }));
      lineGroup.append(
        s("text", { x: plotR - 4, y: yt - 4, "text-anchor": "end" }, t("ch.threshold", { v: display.format(detection.threshold) })),
      );
    }

    const hrP = panels.find((p) => p.key === "hr");
    if (hrP) {
      lineGroup.append(
        s("path", { class: "line-hr", d: pathOf(bucketize(iLo, iHi, plotW, (i) => xOfT(i), px, (i) => series.hr[i], (v) => hrP.y(v))) }),
      );
    }
    const eleP = panels.find((p) => p.key === "ele");
    if (eleP) {
      const pts = bucketize(iLo, iHi, plotW, (i) => xOfT(i), px, (i) => series.altitude[i] * eleScale, (v) => eleP.y(v));
      if (pts.length) {
        const base = eleP.top + eleP.height;
        lineGroup.append(s("path", { class: "area-ele", d: `${pathOf(pts)} L${pts[pts.length - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z` }));
        lineGroup.append(s("path", { class: "line-ele", d: pathOf(pts) }));
      }
    }
    svg.append(lineGroup);

    // ---- segment strip (selection + draggable boundaries) ---------------------------------------
    const stripG = s("g", { "clip-path": `url(#${clipId})` });
    let repNo = 0;
    const repNumber = new Map<number, number>();
    for (const sg of segs) if (sg.kind === "work") repNumber.set(sg.id, ++repNo);
    for (const sg of segs) {
      if (!inView(sg)) continue;
      const xa = pxT(sg.start) + 1;
      const xb = pxT(sg.end) - 1;
      const w = xb - xa;
      if (w < 1) continue;
      const isWork = sg.kind === "work";
      stripG.append(s("rect", { class: isWork ? "seg-work" : "seg-other", x: xa, y: stripTop, width: w, height: STRIP_H, rx: 4 }));
      const label = isWork ? String(repNumber.get(sg.id)) : sg.kind === "warmup" || sg.kind === "cooldown" ? kindLabel(sg.kind) : "";
      const needed = label.length * 7.2 + 8;
      if (label && w >= needed) {
        stripG.append(s("text", { class: `seg-label${isWork ? "" : " other"}`, x: xa + w / 2, y: stripTop + STRIP_H / 2 + 4, "text-anchor": "middle" }, label));
      }
      if (props.selected === sg.id) {
        stripG.append(s("rect", { class: "seg-sel", x: xa - 1, y: stripTop - 1, width: w + 2, height: STRIP_H + 2, rx: 5 }));
      }
      stripG.append(
        s("rect", {
          class: "seg-hit",
          x: xa,
          y: stripTop,
          width: w,
          height: STRIP_H,
          on: { click: () => this.handlers.onSelect(props.selected === sg.id ? null : sg.id) },
        }),
      );
    }
    svg.append(stripG);
    this.hlStrip = s("g", { "clip-path": `url(#${clipId})` });
    svg.append(this.hlStrip);

    // ---- crosshair + overlay ----------------------------------------------------------------------
    this.cross = s("g", { visibility: "hidden" });
    svg.append(this.cross);
    const brush = s("rect", { class: "brush", y: plotTop, height: plotBottom - plotTop, visibility: "hidden" });
    svg.append(brush);
    const overlay = s("rect", { class: "overlay", x: plotL, y: plotTop, width: plotR - plotL, height: plotBottom - plotTop });
    this.attachOverlay(overlay, brush);
    svg.append(overlay);

    // ---- boundary handles: drawn last so they sit above the overlay and can be grabbed anywhere ----
    const handleG = s("g");
    for (let i = 1; i < segs.length; i++) {
      const bt = segs[i].start;
      if (bt <= t0 || bt >= t1) continue;
      handleG.append(this.makeHandle(i, pxT(bt), stripTop, plotBottom, props));
    }
    svg.append(handleG);

    if (this.svg) this.svg.replaceWith(svg);
    else this.el.prepend(svg);
    this.svg = svg;
    this.drawHighlight();
    if (this.cursor !== null) this.showCursor(this.cursor, null);
    if (this.refocus !== null) {
      const handle = svg.querySelector<SVGGElement>(`.handle[data-index="${this.refocus}"]`);
      this.refocus = null;
      handle?.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------------------------------
  // pieces
  // ------------------------------------------------------------------------------------------

  private summaryLabel(): string {
    const { detection, display } = this.props;
    const sum = detection.summary;
    if (!detection.intervalsFound || !sum) return t("ch.summaryNone", { label: display.label });
    return t("ch.summary", { label: display.label, count: sum.repCount, structure: structureText(sum, getLocale()) });
  }

  private xAxis(axisTop: number, px: (x: number) => number, props: ChartProps, series: Series): SVGGElement {
    const g = s("g", { class: "tick-x" });
    const { plotL, plotR, xd0, xd1 } = this.geom;
    const approxTicks = Math.max(2, Math.floor((plotR - plotL) / 90));
    let ticks: number[];
    let fmt: (v: number) => string;
    if (props.xMode === "time") {
      const step = niceStep((xd1 - xd0) / approxTicks, [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200]);
      ticks = ticksBetween(xd0, xd1, step);
      fmt = (v) => duration(v);
    } else {
      const unit = props.units === "imperial" ? 1609.344 : 1000;
      const stepU = niceStep((xd1 - xd0) / unit / approxTicks, [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]);
      ticks = ticksBetween(xd0 / unit, xd1 / unit, stepU).map((v) => v * unit);
      fmt = (v) => `${trimDecimal(+(v / unit).toFixed(2))} ${props.units === "imperial" ? "mi" : "km"}`;
    }
    for (const tv of ticks) {
      const x = px(tv);
      if (x < plotL - 1 || x > plotR + 1) continue;
      g.append(s("line", { class: "axis", x1: x, x2: x, y1: axisTop - 6, y2: axisTop - 2 }));
      g.append(s("text", { x, y: axisTop + 12, "text-anchor": "middle" }, fmt(tv)));
    }
    void series;
    return g;
  }

  private makeHandle(index: number, x: number, top: number, bottom: number, props: ChartProps): SVGGElement {
    const segs = props.detection.segments;
    const before = segs[index - 1];
    const after = segs[index];
    const minT = before.start + MIN_SEG_S;
    const maxT = after.end - MIN_SEG_S;
    const origin = after.start;
    const nameOf = (sg: Segment) => (sg.kind === "work" ? t("insp.rep", { n: props.detection.reps.findIndex((r) => r.id === sg.id) + 1 }) : kindLabel(sg.kind));

    const g = s("g", {
      class: "handle",
      tabindex: "0",
      role: "slider",
      "data-index": String(index),
      "aria-label": t("ch.boundary", { a: nameOf(before), b: nameOf(after), time: duration(origin, 1) }),
      "aria-valuemin": minT.toFixed(1),
      "aria-valuemax": maxT.toFixed(1),
      "aria-valuenow": origin.toFixed(1),
      "aria-valuetext": duration(origin, 1),
    });
    // A visible line and grip at all times, so the boundary is obviously something you can grab.
    g.append(s("line", { class: "handle-line", x1: x, x2: x, y1: top, y2: bottom }));
    g.append(s("rect", { class: "handle-grip", x: x - 2.5, y: top + STRIP_H / 2 - 6, width: 5, height: 12, rx: 2.5 }));
    // The grab area is the header strip only. The line through the panels is just a guide: if it were
    // grabbable too, a drag-to-zoom that starts near a boundary would move the boundary instead.
    const hit = s("rect", { class: "handle-hit", x: x - 7, y: top - 2, width: 14, height: STRIP_H + 4 });
    hit.append(s("title", {}, t("ch.drag")));
    g.append(hit);

    const paceLine = paceSeries(props.series, props.detection.options.paceBasis);
    const paceAt = (time: number) => props.display.formatWithUnit(paceLine[Math.min(props.series.n - 1, Math.max(0, Math.round(time)))]);

    hit.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      hit.setPointerCapture(ev.pointerId);
      g.classList.add("drag");
      this.hideCursor();
      let current = origin;
      const move = (e: PointerEvent) => {
        current = Math.min(maxT, Math.max(minT, this.timeAtClientX(e.clientX)));
        const nx = this.pxOfTime(current);
        g.setAttribute("transform", `translate(${nx - x} 0)`);
        this.showTip(nx, top + STRIP_H, `${duration(current, 1)} · ${fmtDistance(distanceAt(props.series, current), props.units)} · ${paceAt(current)}`);
      };
      const up = () => {
        hit.removeEventListener("pointermove", move);
        hit.removeEventListener("pointerup", up);
        hit.removeEventListener("pointercancel", up);
        g.classList.remove("drag");
        this.tooltip.hidden = true;
        if (Math.abs(current - origin) > 0.05) {
          this.refocus = index;
          this.handlers.onMoveBoundary(index, current);
        }
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerup", up);
      hit.addEventListener("pointercancel", up);
    });

    // Keyboard: arrows nudge by 0.5 s, Shift 5 s, Alt 0.1 s.
    g.addEventListener("keydown", (ev) => {
      const key = (ev as KeyboardEvent).key;
      if (key !== "ArrowLeft" && key !== "ArrowRight") return;
      ev.preventDefault();
      ev.stopPropagation();
      const e = ev as KeyboardEvent;
      const step = e.altKey ? 0.1 : e.shiftKey ? 5 : 0.5;
      const next = Math.min(maxT, Math.max(minT, +(origin + (key === "ArrowRight" ? step : -step)).toFixed(2)));
      if (next === origin) return;
      this.refocus = index;
      this.handlers.onMoveBoundary(index, next);
    });
    return g;
  }

  private attachOverlay(overlay: SVGRectElement, brush: SVGRectElement) {
    let dragStart: number | null = null;
    let moved = false;

    overlay.addEventListener("pointermove", (e) => {
      const t = this.timeAtClientX(e.clientX);
      if (dragStart !== null && !this.props.placing) {
        const x = this.localX(e.clientX);
        if (Math.abs(x - dragStart) > 4) moved = true;
        if (moved) {
          brush.setAttribute("x", String(Math.min(x, dragStart)));
          brush.setAttribute("width", String(Math.abs(x - dragStart)));
          brush.setAttribute("visibility", "visible");
        }
      }
      this.showCursor(Math.round(t), e);
    });
    overlay.addEventListener("pointerleave", () => {
      if (dragStart === null) this.hideCursor();
    });
    overlay.addEventListener("pointerdown", (e) => {
      overlay.setPointerCapture(e.pointerId);
      dragStart = this.localX(e.clientX);
      moved = false;
    });
    const finish = (e: PointerEvent) => {
      if (dragStart === null) return;
      if (this.props.placing) {
        // Placing a boundary: this click chooses the time, nothing else.
        dragStart = null;
        moved = false;
        this.refocus = null;
        this.handlers.onPlace(this.timeAtClientX(e.clientX));
        return;
      }
      const a = this.timeAtX(dragStart);
      const b = this.timeAtClientX(e.clientX);
      brush.setAttribute("visibility", "hidden");
      const wasMoved = moved;
      dragStart = null;
      moved = false;
      if (wasMoved && Math.abs(b - a) >= 10) {
        this.handlers.onZoom([Math.max(0, Math.min(a, b)), Math.min(this.props.series.n - 1, Math.max(a, b))]);
      } else if (!wasMoved) {
        const t = this.timeAtClientX(e.clientX);
        const seg = this.props.detection.segments.find((sg) => t >= sg.start && t < sg.end);
        this.handlers.onSelect(seg && this.props.selected !== seg.id ? seg.id : null);
      }
    };
    overlay.addEventListener("pointerup", finish);
    overlay.addEventListener("pointercancel", () => {
      dragStart = null;
      moved = false;
      brush.setAttribute("visibility", "hidden");
    });
    overlay.addEventListener("dblclick", () => this.handlers.onZoom(null));
  }

  // ------------------------------------------------------------------------------------------
  // coordinate helpers
  // ------------------------------------------------------------------------------------------

  private localX(clientX: number): number {
    return clientX - this.el.getBoundingClientRect().left;
  }

  private timeAtClientX(clientX: number): number {
    return this.timeAtX(this.localX(clientX));
  }

  /** Pixel x (relative to the chart) to time in seconds. */
  private timeAtX(x: number): number {
    const { plotL, plotR, xd0, xd1 } = this.geom;
    const xv = xd0 + ((Math.min(plotR, Math.max(plotL, x)) - plotL) / (plotR - plotL)) * (xd1 - xd0);
    if (this.props.xMode === "time") return Math.min(this.props.series.n - 1, Math.max(0, xv));
    // invert the (monotone) cumulative distance
    const d = this.props.series.dist;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid] < xv) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const span = d[lo] - d[lo - 1];
    return span > 0 ? lo - 1 + (xv - d[lo - 1]) / span : lo;
  }

  private pxOfTime(t: number): number {
    const { plotL, plotR, xd0, xd1 } = this.geom;
    const xv = this.props.xMode === "time" ? t : distanceAt(this.props.series, t);
    return plotL + ((xv - xd0) / (xd1 - xd0)) * (plotR - plotL);
  }

  // ------------------------------------------------------------------------------------------
  // crosshair + tooltip
  // ------------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent) {
    const n = this.props.series.n;
    const { t0, t1 } = this.geom;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const base = this.cursor ?? Math.round((t0 + t1) / 2);
      const next = Math.min(Math.min(n - 1, Math.ceil(t1)), Math.max(Math.max(0, Math.floor(t0)), base + (e.key === "ArrowRight" ? step : -step)));
      this.showCursor(next, null);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.showCursor(e.key === "Home" ? Math.max(0, Math.floor(t0)) : Math.min(n - 1, Math.floor(t1)), null);
    } else if (e.key === "Escape") {
      this.hideCursor();
    } else if (e.key === "Enter" && this.cursor !== null) {
      const seg = this.props.detection.segments.find((sg) => this.cursor! >= sg.start && this.cursor! < sg.end);
      this.handlers.onSelect(seg ? seg.id : null);
    }
  }

  /** Highlight segments on behalf of the rest of the page (a hovered table row, a hovered rep). */
  setHighlight(ids: number[]) {
    this.external = ids;
    this.drawHighlight();
  }

  private setPointerSeg(id: number | null) {
    if (this.pointerSeg === id) return;
    this.pointerSeg = id;
    this.drawHighlight();
    this.handlers.onHover(id);
  }

  private drawHighlight() {
    if (!this.hlBands || !this.hlStrip || !this.props || !this.geom) return;
    clear(this.hlBands);
    clear(this.hlStrip);
    const ids = new Set(this.external);
    if (this.pointerSeg !== null) ids.add(this.pointerSeg);
    if (!ids.size) return;
    const { plotL, plotR, plotTop, plotBottom, t0, t1 } = this.geom;
    for (const sg of this.props.detection.segments) {
      if (!ids.has(sg.id) || sg.end <= t0 || sg.start >= t1) continue;
      const x0 = Math.max(plotL, this.pxOfTime(sg.start));
      const x1 = Math.min(plotR, this.pxOfTime(sg.end));
      this.hlBands.append(s("rect", { class: "band-hover", x: x0, y: plotTop, width: Math.max(0, x1 - x0), height: plotBottom - plotTop }));
      const xa = this.pxOfTime(sg.start) + 1;
      const w = this.pxOfTime(sg.end) - 1 - xa;
      if (w >= 1) this.hlStrip.append(s("rect", { class: "seg-hover", x: xa - 1, y: M.top - 1, width: w + 2, height: STRIP_H + 2, rx: 5 }));
    }
  }

  private hideCursor() {
    this.setPointerSeg(null);
    this.cursor = null;
    if (this.cross) this.cross.setAttribute("visibility", "hidden");
    this.tooltip.hidden = true;
  }

  private showCursor(i: number, pointer: PointerEvent | null) {
    const { series, detection, display, units } = this.props;
    if (!this.cross || !this.svg) return;
    i = Math.max(0, Math.min(series.n - 1, i));
    this.cursor = i;
    const x = this.pxOfTime(i);
    const { plotL, plotR, plotTop, plotBottom } = this.geom;
    if (x < plotL - 1 || x > plotR + 1) {
      this.hideCursor();
      return;
    }
    clear(this.cross);
    this.cross.setAttribute("visibility", "visible");
    this.cross.append(s("line", { class: this.props.placing ? "place-line" : "cross", x1: x, x2: x, y1: plotTop, y2: plotBottom }));

    const seg = detection.segments.find((sg) => i >= sg.start && i < sg.end) ?? detection.segments[detection.segments.length - 1];
    const repNo = seg.kind === "work" ? detection.reps.findIndex((r) => r.id === seg.id) + 1 : 0;
    this.setPointerSeg(seg.id);

    const rows: Array<{ name: string; value: string; color?: string }> = [];
    for (const p of this.panels) {
      if (p.key === "pace") {
        const v = paceSeries(series, detection.options.paceBasis)[i];
        rows.push({ name: display.label, value: display.formatWithUnit(v), color: "var(--s1)" });
        this.cross.append(s("circle", { class: "dot", cx: x, cy: p.y(display.toAxis(v)), r: 3.5, fill: "var(--ink-2)" }));
      } else if (p.key === "hr" && Number.isFinite(series.hr[i])) {
        rows.push({ name: t("tt.hr"), value: `${Math.round(series.hr[i])} ${t("unit.bpm")}`, color: "var(--s2)" });
        this.cross.append(s("circle", { class: "dot", cx: x, cy: p.y(series.hr[i]), r: 3.5, fill: "var(--s2)" }));
      } else if (p.key === "ele" && Number.isFinite(series.altitude[i])) {
        const k = units === "imperial" ? 3.28084 : 1;
        rows.push({ name: t("tt.ele"), value: `${Math.round(series.altitude[i] * k)} ${units === "imperial" ? "ft" : "m"}`, color: "var(--s3)" });
        this.cross.append(s("circle", { class: "dot", cx: x, cy: p.y(series.altitude[i] * k), r: 3.5, fill: "var(--s3)" }));
      }
    }
    if (series.hasCadence && Number.isFinite(series.cadence[i]) && series.cadence[i] > 0) {
      rows.push({ name: t("tt.cad"), value: `${Math.round(series.cadence[i])} ${t("unit.spm")}` });
    }
    if (series.hasAltitude && Math.abs(series.grade[i]) >= 0.005) {
      rows.push({ name: t("tt.grade"), value: `${nf(series.grade[i] * 100, 1)}\u00A0%` });
    }

    const head =
      seg.kind === "work" ? t("tt.rep", { n: repNo }) : kindLabel(seg.kind);
    // What the whole interval did, below what is happening at the pointer.
    const stats: Array<{ name: string; value: string }> = [
      { name: t("tt.duration"), value: duration(seg.duration, seg.duration < 120 ? 1 : 0) },
      { name: t("tt.distance"), value: fmtDistance(seg.distance, units) },
      { name: t(display.isPace ? "tt.avgPace" : "tt.avgSpeed"), value: seg.avgSpeed > 0.3 ? display.formatWithUnit(seg.avgSpeed) : "–" },
    ];
    if (seg.kind === "work" && seg.maxSpeed > 0.3) stats.push({ name: t("tt.best5"), value: display.formatWithUnit(seg.maxSpeed) });
    if (seg.avgHr !== undefined) {
      stats.push({ name: t("tt.avgHr"), value: `${Math.round(seg.avgHr)}${seg.maxHr ? ` · ${t("tt.max")} ${Math.round(seg.maxHr)}` : ""} ${t("unit.bpm")}` });
    }
    if (seg.avgCadence !== undefined) stats.push({ name: t("tt.avgCad"), value: `${Math.round(seg.avgCadence)} ${t("unit.spm")}` });
    if (seg.kind === "work" && seg.fadePct !== undefined) stats.push({ name: t("tt.fade"), value: `${signed(seg.fadePct, 1)}\u00A0%` });
    const row = (name: string, value: string, color?: string) =>
      h(
        "div",
        { class: "tt-row" },
        h("span", { class: "key", style: { borderColor: color ?? "transparent" } }),
        h("span", { class: "n" }, name),
        h("span", { class: "v" }, value),
      );
    this.tooltip.replaceChildren(
      h("div", { class: "tt-head" }, head),
      h("div", { class: "tt-sub" }, `${duration(i)} · ${fmtDistance(series.dist[i], units)}`),
      ...rows.map((r) => row(r.name, r.value, r.color)),
      h("div", { class: "tt-sep" }),
      h("div", { class: "tt-cap" }, t("tt.whole")),
      ...stats.map((r) => row(r.name, r.value)),
    );
    this.tooltip.hidden = false;
    const y = pointer ? pointer.clientY - this.el.getBoundingClientRect().top : plotTop + 40;
    this.placeTip(x, y);
  }

  private showTip(x: number, y: number, text: string) {
    this.tooltip.replaceChildren(h("div", { class: "tt-head" }, text));
    this.tooltip.hidden = false;
    this.placeTip(x, y);
  }

  private placeTip(x: number, y: number) {
    const w = this.tooltip.offsetWidth || 190;
    const hgt = this.tooltip.offsetHeight || 90;
    const total = this.el.clientWidth;
    let left = x + 14;
    if (left + w > total) left = x - w - 14;
    left = Math.max(0, left);
    const maxTop = (this.svg?.clientHeight ?? 400) - hgt;
    const top = Math.max(0, Math.min(maxTop, y - hgt / 2));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }
}

// ---------------------------------------------------------------------------------------------
// drawing helpers
// ---------------------------------------------------------------------------------------------

function pathOf(points: Array<[number, number]>): string {
  if (!points.length) return "M0,0";
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i][0].toFixed(1)},${points[i][1].toFixed(1)}`;
  return d;
}

/**
 * Average samples that fall on the same pixel column so a 2-hour activity is a
 * few hundred points. Works for the time axis and for the distance axis (where
 * paused seconds pile up on a single x).
 */
function bucketize(
  i0: number,
  i1: number,
  plotW: number,
  xOf: (i: number) => number,
  px: (x: number) => number,
  value: (i: number) => number,
  toY: (v: number) => number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let curCol = NaN;
  let sum = 0;
  let cnt = 0;
  let colX = 0;
  const flush = () => {
    if (cnt) out.push([colX, toY(sum / cnt)]);
    sum = 0;
    cnt = 0;
  };
  const step = Math.max(1, Math.floor((i1 - i0) / (plotW * 3)));
  for (let i = i0; i <= i1; i += step) {
    const v = value(i);
    if (!Number.isFinite(v)) continue;
    const x = px(xOf(i));
    const col = Math.round(x);
    if (col !== curCol) {
      flush();
      curCol = col;
      colX = x;
    }
    sum += v;
    cnt++;
  }
  flush();
  return out;
}

function niceStep(raw: number, candidates: number[]): number {
  for (const c of candidates) if (c >= raw) return c;
  return candidates[candidates.length - 1];
}

function ticksBetween(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const start = Math.ceil(lo / step) * step;
  for (let v = start; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** 1.5 -> "1.5" / "1,5"; 2 -> "2". */
function trimDecimal(x: number): string {
  const text = String(x);
  return getLocale() === "fr" ? text.replace(".", ",") : text;
}
