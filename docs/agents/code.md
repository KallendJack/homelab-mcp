# App code

Read before writing or changing code. The project owns its stack, module layout and deployment procedure.
Use Matt's codebase-design and tdd skills for module design and testing conventions.

- **Checks:** one documented command runs lint, typechecking and tests. Use `check` in new repos; preserve an
  existing equivalent. Run browser tests and builds in CI when the project has them.
- **Reproducibility:** pin the runtime and package manager, commit the lockfile, and send dependency updates
  through the same CI as other changes.
- **Formatting:** the project's formatter decides formatting.
- **Types:** use the compiler's strict checks and validate external input before using it. In TypeScript,
  start from `tsconfig.house.json` and `biome.house.json`; preserve project-specific settings.
- **Size:** source files stay under 400 lines and folders under 15 source files. The size check permits existing
  excess through a baseline that may shrink but not grow. Split by responsibility, following the project's layout.
- **Security:** check access on routes that handle data, escape output, and use parameterised queries.
- **Migrations:** schema changes use new migrations; applied migrations stay unchanged.
