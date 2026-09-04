# ADR 0002: Internal read-only diff renderer

Date: 2026-09-04

## Status

Accepted for v0.8.

## Context

Clew needs a compact Preact-compatible viewer for a server-produced unified patch. The release must remain installable from the repository lockfiles in an offline acceptance environment. The viewer must support file navigation, unified and split layouts, long lines, binary/empty/unavailable states, and keyboard-accessible controls.

## Bounded spike

| Candidate          | Bundle impact                                                                    | Preact integration                                             | Unified patch                                                                             | Highlighting                                             | Large diff                                                            | Accessibility                                              | Maintenance/license       | Decision                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Monaco Diff Editor | High: editor runtime and workers are substantially larger than Clew's current UI | Requires a wrapper and worker configuration                    | Requires reconstructing original/modified models rather than consuming the patch directly | Excellent                                                | Virtualized                                                           | Strong keyboard foundation                                 | Active, MIT               | Rejected for v0.8: too much runtime and integration surface for read-only patches                                                           |
| `react-diff-view`  | Medium                                                                           | React-specific API needs compatibility validation under Preact | Native parser/view model                                                                  | Supports token decoration through additional integration | Supports widgets but large-patch policy remains application-owned     | Requires application-level focus/navigation work           | Open source               | Rejected for v0.8: adds a React compatibility boundary and another highlighting integration                                                 |
| `diff2html`        | Medium                                                                           | Framework-neutral rendering is possible                        | Native unified-diff parser                                                                | Built-in presentation with optional highlighting         | Whole-document HTML can be costly for large patches                   | Generated markup needs additional focus semantics          | Open source, MIT          | Rejected for v0.8: dependency could not be fetched in the offline build gate and generated HTML would need a separate sanitization boundary |
| Internal renderer  | 0 dependency bytes; measured in the existing UI bundle                           | Native Preact                                                  | Consumes the persisted patch directly                                                     | Structural add/delete/hunk/header highlighting           | File-scoped rendering limits DOM size; long lines scroll horizontally | Native buttons, pressed/current state and labelled regions | Maintained with Clew, MIT | Accepted                                                                                                                                    |

The candidate package fetch was deliberately treated as a release gate: a viewer that cannot be reproduced from the checked-in lockfiles is not accepted. The internal renderer adds no runtime dependency and keeps patch text in Preact text nodes rather than injecting HTML.

## Decision

Use the internal renderer for v0.8. It splits patches by file, exposes keyboard-accessible file buttons, offers unified and split-readable modes, highlights structural line types, and renders binary/empty/unavailable states without trusting HTML from Git output.

## Consequences

- Clew avoids a new React compatibility or HTML-sanitization boundary.
- Syntax-token highlighting and advanced intra-line diffs remain future enhancements.
- A later viewer adapter may replace the renderer if it passes bundle, offline reproducibility, accessibility, and large-diff gates.
