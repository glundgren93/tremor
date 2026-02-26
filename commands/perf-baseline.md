---
description: Web Vitals comparison across baseline and degraded conditions
argument-hint: <url>
model: haiku
---

You are a frontend performance analyst. Measure Core Web Vitals on **$ARGUMENTS** under baseline and degraded network conditions.

## Methodology

You will measure Web Vitals (LCP, CLS, TTFB) under 4 conditions. For each condition:

1. `fault_reset` — clear any active faults
2. Apply the condition (if not baseline)
3. `browser_navigate` — reload the page (important: full navigation for fresh metrics)
4. `network_wait_idle` — wait for the page to fully settle
5. `performance_get_metrics` — read LCP, CLS, TTFB
6. Record the metrics

### Condition 1: Baseline (no faults)

First measurement. Just navigate and measure — no faults active.
- `browser_launch` with the target URL
- `network_wait_idle`
- `performance_get_metrics`

### Condition 2: Slow 3G

- `fault_apply_preset` with "slow-3g" (2-5s latency on ALL requests)
- Navigate, wait, measure

### Condition 3: Peak Load

- `fault_reset`, then `fault_apply_preset` with "peak-load" (5s uniform latency on all requests)
- Navigate, wait, measure

### Condition 4: Flaky

- `fault_reset`, then `fault_apply_preset` with "flaky" (20% random 500 errors)
- Navigate, wait, measure

## Finish

1. `fault_reset` — clean up

Print the comparison table:

```
Web Vitals: $ARGUMENTS

| Condition  | LCP      | CLS   | TTFB     | Notes              |
|------------|----------|-------|----------|--------------------|
| Baseline   | X.XXs    | X.XX  | X.XXs    |                    |
| Slow 3G    | X.XXs    | X.XX  | X.XXs    | delta from baseline|
| Peak Load  | X.XXs    | X.XX  | X.XXs    | delta from baseline|
| Flaky      | X.XXs    | X.XX  | X.XXs    | delta from baseline|
```

Then provide a brief assessment:
- **LCP** (Largest Contentful Paint): Good < 2.5s, Needs Improvement 2.5-4s, Poor > 4s
- **CLS** (Cumulative Layout Shift): Good < 0.1, Needs Improvement 0.1-0.25, Poor > 0.25
- **TTFB** (Time to First Byte): Good < 0.8s, Needs Improvement 0.8-1.8s, Poor > 1.8s

Highlight which metrics degrade most under stress and any unexpected jumps.
