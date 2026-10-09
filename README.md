# Interval Analyzer

Drop a Garmin `.fit` activity into the page and get a precise breakdown of an
interval session: every **rep, rest, warm-up and cool-down** with duration,
distance, pace, heart rate, cadence, elevation and fade.

**Runs entirely in the browser.** There is no backend and nothing is uploaded; the
file is decoded and analysed by JavaScript in your tab. The production build is a
single `index.html` you can open straight from disk.

## Use it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/index.html (single self-contained file, works from file://)
npm test           # unit tests + precision benchmark
```

Get a file: Garmin Connect (web) → open the activity → ⚙ → **Export Original**
(you get a zip containing the `.fit`), or copy it from the watch's
`GARMIN/Activity` folder. Then drop it on the page. `samples/` holds simulated
sessions to try (regenerate with `npm run samples`); the landing page also has
one-click demos.

## Languages

The interface is available in **English and French**. It follows the browser language on first
visit; the **EN | FR** switch in the header changes it (and is remembered), and `?lang=fr` /
`?lang=en` in the URL forces one. Messages from the analysis engine are keyed, not hard-coded, so
they switch language instantly without re-analysing. To add a language, copy `src/i18n/fr.ts`
(the compiler checks that every key is translated) and register it in `src/i18n/index.ts`.

## Host it on GitHub Pages

The build is one static file, so any static host works. For GitHub Pages:

1. In the repo go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Go to **Settings → Environments → github-pages → Deployment branches and tags** and allow the
   branch you deploy from (by default GitHub only allows the default branch).
3. Push to a branch listed in `.github/workflows/pages.yml` (`main` and `claude/sleepy-tesla-h39nbp`),
   or run the *Deploy to GitHub Pages* workflow from the Actions tab.

It is then served at `https://<user>.github.io/Intervals/`. The workflow in
`.github/workflows/pages.yml` runs the tests, builds, and deploys. The site is
public, but files you drop on it are still analysed only in the visitor's browser.

## What it detects

| Session type | How it is handled |
| --- | --- |
| Structured workout on the watch | Uses the lap intensities the watch recorded (warm-up / active / rest / cool-down). Never moved: the watch ended those steps exactly. |
| Manual lap-button laps | Laps are classified by pace; boundaries are snapped to the nearest real pace change (the button is pressed a second or three early/late). |
| Fartlek / no laps / auto-km laps | Intervals are found from the pace signal alone. Automatic per-km laps are recognised and ignored, even when the watch tags each of them "interval" (fenix): a structured workout needs laps with *different* intensities. |
| Variable reps (pyramids, ladders) | Each rep is measured separately; the description is the sequence (`400 m · 800 m · 1.2 km · 800 m · 400 m / 2 min rest`). |
| Hills | Grade-adjusted pace (Minetti cost model) is used automatically on hilly routes, so a slow climb is correctly "hard" and the jog down "easy". |
| Standing rests with auto-pause | A pause is a rest segment with its true duration, not a gap. |

"Source" and "Pace type" can be forced in the settings row, and the work/rest
threshold, sensitivity and minimum rep / rest length are adjustable. Every
boundary can be corrected with the mouse or keyboard, and everything recomputes:

- **Drag** a boundary by its grip in the header strip above the chart (the line through the chart is only
  a guide, so dragging across the chart to zoom never moves a boundary). Zoom in first for sub-second control.
- **Place on chart**: select a rep, press *Place start on chart* / *Place end on chart*, then
  click where it should begin or end. A guide line follows the pointer and the tooltip shows the
  pace under it, which makes it easy to pick the middle of a slow ramp. Esc cancels.
- **Keyboard**: focus a boundary (Tab) and press ← / → to move it by 0.5 s (Shift 5 s, Alt 0.1 s).
- Segments can also be re-typed, merged or split. Results export to CSV.

## Detection settings

| Setting | What it does |
| --- | --- |
| **Source** | Device laps, the pace signal, or Auto (laps when they carry real structure). |
| **Pace type** | Plain pace, grade-adjusted pace (hills), or Auto (grade-adjusted on hilly routes). |
| **Pace from** | *Distance ÷ time* (default, like the lap table in Garmin Connect) or *Watch speed* (the speed channel the watch recorded, like its screen while you run). Only shown when the file has a speed channel. Changing it only changes the numbers, not the intervals found. |
| **Sensitivity** | How small a change of pace counts as the start/end of an interval. Higher finds shorter, subtler changes. |
| **Interval edges** | *Where on a change of pace* an interval starts and ends. **Beep to beep** (default): from the first clear acceleration (effort 20 %) until just before the pace drops (effort 80 %), moved back by a 0.5 s reaction time. **Half-way**: the middle of each change. **Steady pace only**: just the plateau (cleanest pace, but shorter reps). Start, end and reaction time can also be set by hand. |
| **Min rep / Min rest** | Shortest hard effort and shortest recovery that count. |
| **Work/rest threshold** | The pace that separates hard from easy (automatic by default). |
| **Snap laps to pace** | Moves lap-button laps to the nearest real change of pace. |

Why beep to beep? When the watch beeps (or a whistle blows) the pace only changes a moment later, and the
pace drops a moment after the end beep. Measured against the real beep on simulated sessions, half-way
placement lands about 2 s (up to 4.7 s on slow ramps) late on both edges, while beep to beep lands within
0.3-1.1 s (`npm run bench`). The price: a rep includes its acceleration, so its average pace is a few
seconds per km slower than the steady pace (the same as the watch's own lap average). Use *Steady pace only*
for the cleanest pace, knowing that reps then come out about 5 s / 7 % short.

`samples/8x400-slow-acceleration.fit` has a slow ~30 s build-up into each rep: try the three strategies
and watch the starts and ends move.

**Two ways to read a pace.** A Garmin file holds a distance curve and, separately, a speed channel. Most of the
time they agree. They can differ for two reasons:

- the watch smooths its speed over several seconds and reports it a few seconds late (the app measures that delay,
  often 4-6 s, and compensates for it when placing the edges), so on a 30-60 s rep the speed never reaches the
  pace you actually ran: the live pace on the watch understates short efforts;
- on some files the speed channel reads a few percent below (or above) the speed implied by the distance, whatever the
  smoothing. When that exceeds 3 % the app says so.

By default the app reports **distance ÷ time**, the same as the lap table in Garmin Connect, and plots the speed implied
by the distance curve, so chart and table agree. Choose **Watch speed** in *Pace from* to see what the watch showed
instead. Selecting an interval always shows both numbers, and the CSV has both. The file alone cannot tell which one
is closer to the truth: check a known distance (a 400 m track lap, a measured km) if it matters.

## How the detection works

1. **Time series.** Records are resampled to a uniform 1 Hz grid on the wall clock.
   Pauses (timer events, or long gaps) become explicit zero-speed seconds, GPS
   spikes are removed, and altitude is smoothed into a grade for grade-adjusted pace.
2. **Lag compensation.** Device speed is smoothed, so it trails real changes of
   pace (up to 8 s is searched for). The lag against the distance curve is estimated by least-squares
   alignment over the whole file and removed (a no-op if there is none).
3. **Segmentation.** Exact optimal piecewise-constant segmentation (PELT with a
   minimum segment length; verified against brute-force dynamic programming).
   The penalty comes from the measured noise and a minimum meaningful speed step,
   so it adapts to each file instead of using a magic number.
4. **Classification.** An Otsu split of the *moving* segments gives the work/rest
   threshold (stopped time is excluded so standing rests cannot drag it down).
   Runs shorter than the minimum rep / rest are absorbed. Runs before the first
   rep are the warm-up, after the last the cool-down.
5. **Boundary refinement.** Each boundary is re-fitted as a two-level step against
   the raw signal and interpolated below one sample. The boundary is the
   **half-way point of the change of pace**, not where the athlete reached full
   speed.
6. **Metrics.** Distance comes from the recorded cumulative-distance curve
   evaluated at the exact (fractional) boundaries; pace is distance / moving
   time (or, with *Watch speed*, the integral of the recorded speed over the same span). Summary statistics (variability, first→last trend, rest, HR recovery) are
   computed on the largest group of similar reps so a pyramid or a block of
   strides does not distort them.

## Precision

Measured against simulated sessions with known ground truth (12 random seeds per
scenario; GPS noise, device smoothing, spikes, auto-pause, 10 Hz physics sampled at
1 Hz). Reproduce with `npm run bench`.

| Scenario | Reps found exactly | Boundary error, mean / p95 | Rep distance error, p95 |
| --- | --- | --- | --- |
| clean | 100 % | 0.11 s / 0.19 s | 0.13 % |
| typical | 100 % | 0.35 s / 0.85 s | 0.60 % |
| noisy GPS + spikes | 100 % | 0.69 s / 1.84 s | 2.8 % |
| heavy device smoothing | 100 % | 0.19 s / 0.40 s | 0.27 % |
| 12 × 200 m | 100 % | 0.25 s / 0.54 s | 1.06 % |
| pyramid | 100 % | 0.43 s / 0.85 s | 0.64 % |
| fartlek (time based) | 100 % | 0.58 s / 1.35 s | 1.19 % |
| standing rests, auto-pause | 100 % | 0.25 s / 0.48 s | 0.30 % |
| hill repeats (grade-adjusted) | 100 % | 1.37 s / 3.16 s | 5.2 % |

**Read these honestly.** They prove the algorithm recovers what it is given; they
do not prove it matches your watch. Caveats:

- The simulator and the parser share Garmin's SDK, so the parser has not been
  validated against a large set of real device files (it follows the FIT spec and
  tolerates missing fields, smart recording, pauses and multi-session files).
  If a file misbehaves, please report it.
- "Boundary" means the half-way point of the acceleration, typically ~1 s *after*
  the athlete crossed a start/finish line. Rep **durations** are unaffected; rep
  **distance** can differ from the marked distance by that second at rep speed.
  Structured-workout laps have no such offset.
- Hills are inherently less sharp: grade comes from a barometric altitude that
  needs ~12 s of smoothing.

## Project layout

```
src/fit/        FIT decoding (official @garmin/fitsdk) into a normalised Activity
src/analysis/   timeseries, change-points (PELT), signal & lap detection, metrics, summary
src/sample/     synthetic workout generator + FIT encoder (tests, demos, samples/)
src/ui/         the browser app (vanilla TypeScript, hand-built SVG chart)
tests/          unit tests, FIT round-trip, precision benchmark
```

## Notes

- The Garmin FIT SDK is used under the [FIT Protocol License](node_modules/@garmin/fitsdk/LICENSE.txt).
- Text from files is always inserted as text nodes, never as HTML.
