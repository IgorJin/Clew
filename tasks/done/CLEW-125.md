---
id: CLEW-125
title: Initial scout context for architect and worker
status: done
release: unassigned
priority: P1
size: M
depends_on: [CLEW-124]
parallel_group: null
owner: codex
updated: 2026-09-12
evidence_policy: v1
---

# CLEW-125 — Initial scout context for architect and worker

## Objective

Подключить выбранный RepositoryContext к существующим architect/worker briefs до появления checkpoints.

## User outcome

Пользователь может выбрать карту для следующего запуска и видеть, какая версия контекста использовалась.

## Context

[Scout v0](../../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Использовать `config.scoutEnabled` из `ENABLE_SCOUT` в проектном `.env` (с приоритетом явной переменной окружения): по умолчанию прежний flow без scout context. Явный выбор карты при выключенном флаге возвращает понятную ошибку до запуска; включённый флаг разрешает выбор, но не запускает Scout автоматически.

- Добавить явный выбор contextId в локальный запуск Task и тонкий context block в текущий Execution Brief; записать фактически использованные contextId/checksum/revision с Run.
- Проверять scope, Task fingerprint, repo identity и актуальность revision; stale context допускает новое исследование либо явный запуск без scout.
- Включать только нужный bounded блок со ссылками/unknowns; сохранять обязательные критерии/permissions. Обычный запуск без карты остаётся доступен; scout failure не меняет Task state.

## Out of scope

Checkpoint engine CLEW-114/115, автоматический повторный scout в середине задачи, новый workflow stage/QA policy.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Quick/Standard workers и Deep architect/worker получают выбранный актуальный контекст как данные, а не новый Task Contract; provenance привязан к каждому использовавшему его Run.
2. Изменение требований/revision, missing/corrupt context и oversized brief дают понятный отказ использования карты; явный запуск без scout сохраняет прежний путь.
3. Run restart/retry сохраняет фактически выбранный context ID без silent replacement; новая версия выбирается явно. Paired режим не переносит local files/raw output и явно сообщает unsupported scout context.

## Acceptance evidence

Пути и результаты зафиксированы ниже.

| Criterion | Automated evidence                     | Logical scenarios                                                             | Result |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| AC-1      | `test/scout-handoff.test.js`, группа 1 | profile brief fixtures; selected sections; instruction precedence; provenance | pass   |
| AC-2      | `test/scout-handoff.test.js`, группа 2 | freshness matrix; changed requirements; missing body; explicit skip           | pass   |
| AC-3      | `test/scout-handoff.test.js`, группа 3 | restart/retry; new context version; paired allowlist; no-scout regression     | pass   |

## Verification

- `node --test test/scout-handoff.test.js test/execution-brief.test.js test/scout-context.test.js test/scout-execution.test.js` — 25 pass, 0 fail.
- `npm test` — 252 pass, 10 environment skips, 0 fail.
- `npm run lint`, `npm run tasks:check` и Prettier по затронутым файлам — pass.
- Реальные consumer прогоны остаются в CLEW-126.

## Review record

- Verdict: pass
- Reviewer: Codex counterexample-oriented implementation review, 2026-09-12
- Findings: Проверены передача selected bounded context в Quick/Standard и Deep architect/worker briefs, сохранение provenance в Run, stale/missing/corrupt/oversized отказ до execution, явный no-scout, retry/restart reuse и paired boundary. Блокирующих замечаний не осталось.

## Dependencies and parallelization

Зависит от завершённой [CLEW-124](./CLEW-124.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом. Карточка была следующим шагом scout v0.

## Risks

Изменившийся код делает исходную карту потенциально устаревшей; Deep не должен автоматически считать её актуальной для всех последующих Stages.

## Blockers

None.

## Completion record

Initial Scout handoff реализован через `--scout-context`, `--scout-sections` и `--no-scout`. Scheduler валидирует выбранный context против Task fingerprint, Project/repository identity, scope и revision до создания worktree или запуска harness; после проверки в Execution Brief попадает только bounded блок до 16 КиБ с identity/checksum/source references/unknowns. Quick и Standard передают его worker, Deep — архитектору и worker stages; integration/reviewer/QA и paired Runner не получают локальную карту.

Фактически использованные context ID, checksum, revision и sections сохраняются в Run, а выбор фиксируется в Task history для продолжения после Deep plan approval. Retry/restart повторно используют выбранную версию, явный новый context ID выбирает новую карту, `--no-scout` сохраняет старый путь. Добавлена schema/migration 24 и fixtures `test/scout-handoff.test.js` для всех acceptance criteria.
