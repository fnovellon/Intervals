# Changelog

All notable changes to Interval Analyzer are listed here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version numbers follow [Semantic Versioning](https://semver.org/): while the app is
0.x, a minor bump (0.x.0) adds features or changes results, a patch bump (0.x.y) only
fixes bugs. The current version is shown in the footer of the app, which also lists
this file ("What's new").

How to release: add the changes under a new `## [x.y.z] - YYYY-MM-DD` heading, set the
same number in `package.json`, and run `npm test` (a test checks that both agree).

## [0.6.0] - 2026-10-09

### Added
- **Effort start** setting (Auto / From a stop / Jogging): says whether you set off for an
  effort from a standstill or from a jog, and adapts where each effort is said to begin.
- Hovering an interval on the chart shows its statistics (duration, distance, pace, heart
  rate, cadence, best 5 s) in the tooltip, next to the values at the pointer.
- Hovering a rep in the detected session, or a row of the table, highlights that interval
  on the chart (and the other way round).
- A plain-language description under every detection setting, in English and French.
- The settings panel can be collapsed (the choice is remembered; it starts collapsed on a phone).
- Version number in the header and footer, and this changelog inside the app.

### Changed
- The detected-session line at the top of the results is smaller, so it takes two lines instead of five.
- The settings are laid out in a grid so each description sits under its control.

### Fixed
- When a recovery was first standing and then jogging, the next effort was said to start with
  the jog (the start was up to 15 s too early, and the rep pace too slow). It now starts where
  the pace picks up from the jog.

## [0.5.0] - 2026-10-09

### Added
- **Pace from** setting: distance ÷ time (default, like Garmin Connect's lap table) or the speed
  the watch recorded. Every interval keeps both readings, the CSV has both columns, and the
  chart, tooltip and legend follow the choice.
- A speed series derived from the distance curve (5 s window) that needs no lag compensation.

### Fixed
- Watches that tag every automatic per-km lap "interval" (fenix) were taken for a structured
  workout and their laps were used instead of the pace signal. A structured workout now needs
  laps with at least two different intensities.
- The speed/distance lag search stopped at 4 s; real files show 5 s or more. It now goes up to 8 s.

## [0.4.0] - 2026-10-09

### Added
- Interval edges strategy: "Beep to beep" (default), "Half-way" and "Steady pace only", with
  start/end effort and reaction time, so an interval starts at the first clear acceleration and
  ends just before the pace drops, as the watch's beep or a whistle would define it.
- A note and a comparison in the inspector when the watch's speed and its own distance disagree
  by more than 3 %.

### Changed
- Boundary handles can only be grabbed in the header strip, so dragging across the chart to zoom
  never moves a boundary.

### Fixed
- Grade-adjusted pace differed from the pace on flat ground; it is now computed from the
  segment's own pace and equals it exactly without a slope.

## [0.3.0] - 2026-10-09

### Added
- Place a boundary by clicking on the chart (guide line and pace under the pointer), and move
  boundaries with the keyboard (arrows: 0.5 s, Shift 5 s, Alt 0.1 s).
- Edge-position setting and tooltips explaining each detection setting.
- A sample file with a slow build-up into each rep.

### Changed
- Smaller pointer, slimmer handles and grab areas, thinner guide line.

## [0.2.0] - 2026-10-09

### Added
- French translation with an EN | FR switch (the language follows the browser, `?lang=` forces one).
- GitHub Pages deployment workflow and hosting instructions.

## [0.1.0] - 2026-10-09

### Added
- First release: Garmin `.fit` decoding in the browser (nothing is uploaded), interval detection
  from structured-workout laps, lap-button laps or the pace signal alone, grade-adjusted pace for
  hills, per-rep metrics and session summary, draggable boundaries, CSV export, simulated demo
  sessions and a precision benchmark.
