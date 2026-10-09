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

## What it detects

| Session type | How it is handled |
| --- | --- |
| Structured workout on the watch | Uses the lap intensities the watch recorded (warm-up / active / rest / cool-down). Never moved: the watch ended those steps exactly. |
| Manual lap-button laps | Laps are classified by pace; boundaries are snapped to the nearest real pace change (the button is pressed a second or three early/late). |
| Fartlek / no laps / auto-km laps | Intervals are found from the pace signal alone. Automatic per-km laps are recognised and ignored. |
| Variable reps (pyramids, ladders) | Each rep is measured separately; the description is the sequence (`400 m · 800 m · 1.2 km · 800 m · 400 m / 2 min rest`). |
| Hills | Grade-adjusted pace (Minetti cost model) is used automatically on hilly routes, so a slow climb is correctly "hard" and the jog down "easy". |
| Standing rests with auto-pause | A pause is a rest segment with its true duration, not a gap. |

"Source" and "Pace type" can be forced in the settings row, and the work/rest
threshold, sensitivity and minimum rep / rest length are adjustable. Every
boundary can be dragged on the strip above the chart; segments can be re-typed,
merged or split, and everything recomputes. Results export to CSV.

## How the detection works

1. **Time series.** Records are resampled to a uniform 1 Hz grid on the wall clock.
   Pauses (timer events, or long gaps) become explicit zero-speed seconds, GPS
   spikes are removed, and altitude is smoothed into a grade for grade-adjusted pace.
2. **Lag compensation.** Device speed is smoothed, so it trails real changes of
   pace. The lag against the distance curve is estimated by least-squares
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
   time. Summary statistics (variability, first→last trend, rest, HR recovery) are
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
