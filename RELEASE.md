# Clew v0.1 release plan

**Release status:** Planned — implementation not started

**Release goal:** prove that Clew can keep one task thread across native harness execution, Git worktrees, verification, review, and retry.

This document is the release gate for v0.1. The detailed implementation backlog is in [`tasks.md`](./tasks.md); the product and technical contract is in [`spec.md`](./spec.md).

## Release shape

v0.1 is delivered through three release candidates. Each candidate is useful on its own and reduces a different risk.

### v0.1.0-alpha.1 — Quick / Codex vertical slice

The first usable local flow:

```text
task contract
→ isolated Git worktree
→ native Codex turn
→ normalized events
→ observed verification evidence
→ truthful task state
```

Required backlog tasks: `CLEW-001`–`005`, `006`, `008`–`022`.

Gate to pass:

- a clean checkout installs and runs the CLI;
- Codex app-server protocol is proven and version-diagnosed;
- a task can be created and inspected;
- the primary checkout remains unchanged while the worker uses a worktree;
- `turn/completed` does not directly mark the task complete;
- verification evidence is linked to the exact attempt, workspace, and revision;
- restart, interrupt, and failure paths leave an explainable state.

### v0.1.0-beta.1 — Standard / review / retry

The dependable single-worker flow:

```text
isolated worker
→ progressive verification
→ native reviewer
→ pass or structured findings
→ native-session retry under policy
```

Required backlog tasks: `CLEW-023`–`028`.

Gate to pass:

- effective profile and policy are persisted per run;
- reviewer output is schema-validated and linked to evidence/criteria;
- blocking findings create a new attempt, not an untracked prompt;
- simple failures reuse a native session and repeated failures can start fresh;
- maximum attempts and human gates are enforced;
- the Standard end-to-end fixture passes and preserves complete history.

### v0.1.0-rc.1 — Deep / parallel / OpenCode

The architecture promised by the v0.1 specification:

```text
native Codex architect
→ validated plan + human approval
→ parallel Codex/OpenCode stages in isolated worktrees
→ deterministic integration
→ broad verification
→ native review
```

Required backlog tasks: `CLEW-029`–`036`.

Gate to pass:

- OpenCode uses a pinned SDK/server version behind its adapter;
- the architect is read-only and produces a schema-valid acyclic plan;
- independent stages cannot share a workspace or double-start;
- every parallel run has an explicit integration stage;
- merge conflicts and failed siblings become explicit states;
- the Deep fixture passes once with a routed retry scenario.

## v0.1 final release gate

The final `v0.1.0` tag may be created only after:

1. `CLEW-037`–`041` are complete.
2. All ten v0.1 acceptance criteria in [`spec.md`](./spec.md) have automated checks or a documented manual procedure.
3. A clean checkout can run the Quick, Standard, and Deep fixtures with supported local dependencies.
4. `clew doctor` reports missing binaries, auth, version, and configuration problems without leaking secrets.
5. Cancellation, timeouts, process crashes, and restart recovery do not orphan owned worktrees or falsify state.
6. No required flow depends on stdout scraping, a generic model API, or a third-party orchestration runtime.
7. The release notes list supported harness versions, platform assumptions, known limitations, and data-retention behavior.

## Release artifacts

The release branch/tag must contain:

- `spec.md` — product and technical contract;
- `tasks.md` — implementation backlog and dependencies;
- `RELEASE.md` — this gate and candidate definition;
- `README.md` — install, quick start, and supported configuration;
- `CHANGELOG.md` — user-visible changes and known limitations;
- versioned schema fixtures and migration files;
- reproducible acceptance fixtures for Quick, Standard, and Deep;
- adapter compatibility diagnostics;
- a documented clean-install command sequence.

## Versioning and branch policy

- Candidate versions use `v0.1.0-alpha.N`, `v0.1.0-beta.N`, and `v0.1.0-rc.N`.
- The final release is `v0.1.0`.
- Release work lands on `main` through reviewable changes; no long-lived release branch is required until a candidate needs stabilization.
- A candidate tag is created only from a clean tree and only after its gate is recorded in the release notes.
- Protocol versions and package versions used by adapters are pinned in the release artifacts.

## Recommended execution order

1. Bootstrap the toolchain and schema contracts.
2. Run Codex, OpenCode, and Git worktree spikes in parallel where possible.
3. Stop and review spike evidence before committing to adapter details.
4. Build the fake-harness scheduler before coupling it to external processes.
5. Ship `alpha.1` as soon as the Quick fixture is reproducible.
6. Add review/retry and ship `beta.1`.
7. Add parallel integration and OpenCode, then harden for `rc.1`.
8. Perform the final acceptance, security, diagnostics, and clean-install pass before `v0.1.0`.

## Explicitly out of v0.1 release gate

These are not release blockers:

- dashboard UI;
- Phoenix/OpenTelemetry backend;
- cost/token analytics;
- remote or multi-process scheduling;
- automatic pull-request/merge integration;
- runtime namespace isolation for databases, ports, and containers;
- Orca, Beads, OpenHands, or OpenChamber as core dependencies.

They remain post-v0.1 backlog items until real usage demonstrates a need.
