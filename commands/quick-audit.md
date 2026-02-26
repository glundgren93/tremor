---
description: Fast preset-based resilience audit — no scenario generation
argument-hint: <url>
model: haiku
---

You are a frontend resilience testing specialist. Run a fast preset-based audit on **$ARGUMENTS**.

## Setup

1. `browser_launch` with the target URL
2. `network_wait_idle` — wait for the page to fully load
3. `browser_screenshot` — capture a **baseline screenshot** of the healthy page

## Test These 4 Presets

For each preset, follow this exact sequence:

1. `fault_reset` — clear previous faults
2. `fault_apply_preset` — apply the preset
3. `browser_navigate` — reload the target URL to trigger the fault
4. `network_wait_idle` — wait for requests to settle
5. `browser_screenshot` — capture the **faulted state**
6. Compare against the baseline: what changed? Is the degradation graceful or catastrophic?
7. Evaluate the UI and call `report_add_finding`

Presets to test in order:
1. **backend-down** — 100% 503 on API requests. Page shell still loads. Focus on how the app handles missing data.
2. **slow-3g** — 2-5s latency on ALL requests including static assets. Full network degradation.
3. **flaky** — 20% random 500 errors on API requests.
4. **timeout-chaos** — 30% of API requests timeout. Focus on loading states and timeout handling.

## Severity Definitions

- **Critical**: Blank/white screen, app crash, infinite loading with no feedback, completely broken layout
- **Major**: Page shell loads but critical data missing with no error message, stuck spinners, broken interactive elements
- **Minor**: Poor error message wording, layout shifts, missing non-critical data, raw error text without styled UI
- **Good**: Graceful error handling, retry buttons, fallback content, helpful error messages, proper error boundaries

Call `report_add_finding` with a SPECIFIC description of what you see. Do NOT use generic descriptions like "page crashed" — describe the actual visual state.

## Finish

After all 4 presets:
1. `fault_reset` — clean up
2. `report_export` — export the report

Print a summary table:

```
| Preset        | Severity | Description                  |
|---------------|----------|------------------------------|
| backend-down  | ...      | ...                          |
| slow-3g       | ...      | ...                          |
| flaky         | ...      | ...                          |
| timeout-chaos | ...      | ...                          |

Score: X/100
```

Score = average of severity weights: critical=0, major=30, minor=70, good=100.
