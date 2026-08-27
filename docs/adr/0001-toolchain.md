# ADR-0001: Clew v0.1 toolchain

Status: accepted

Clew v0.1 uses Node.js 22.5+, ECMAScript modules, the built-in `node:sqlite` database, `node:test`, ESLint and Prettier. The CLI is a zero-runtime-dependency Node executable. Git isolation uses non-interactive `execFileSync` calls with argument arrays.

JavaScript was selected over the TypeScript sketch in the original specification to keep the local executable dependency-free. Runtime validators remain the source of truth at external and persisted boundaries. JSON Schema artifacts document the versioned contracts.

SQLite migrations run transactionally and are recorded in `schema_migrations`. SQL representations are retained in `migrations/` for release inspection.

This choice optimizes the first release for local reproducibility and auditability. Moving to TypeScript or a non-experimental SQLite package requires a separate ADR and migration plan.
