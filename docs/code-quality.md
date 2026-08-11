# Code quality measurements

## Module size

Run `pnpm quality:module-size` to check production modules under `src/`.

A code line is a unique source line occupied by a non-trivia TypeScript token. Blank lines and
comments do not count. The report also shows implemented function count, top-level export count,
and the largest function in each module.

The committed baseline in `quality/module-size-baseline.json` applies these limits:

- Existing modules may grow to 400 code lines.
- Existing modules already above 400 may not exceed their baseline size.
- Modules absent from the baseline may contain at most 300 code lines.

A reduction in an oversized module is reported as an available ratchet. Update the baseline with
`pnpm quality:module-size:baseline` in the same reviewed change that performs the reduction. Do not
update the baseline merely to accept module growth.

Use `pnpm --silent quality:module-size:report` for the machine-readable JSON report.
