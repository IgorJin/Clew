---
id: CLEW-125
title: Initial scout context for architect and worker
status: ready
release: unassigned
priority: P1
size: M
depends_on: [CLEW-124]
parallel_group: null
owner: null
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-125 — Initial scout context for architect and worker

## Objective

Подключить выбранный RepositoryContext к существующим architect/worker briefs до появления checkpoints.

## User outcome

Пользователь может выбрать карту для следующего запуска и видеть, какая версия контекста использовалась.

## Context

[Scout v0](../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

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

Пути — планируемые тесты; результаты пока не получены.

| Criterion | Automated evidence                     | Logical scenarios                                                             | Result  |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| AC-1      | `test/scout-handoff.test.js`, группа 1 | profile brief fixtures; selected sections; instruction precedence; provenance | pending |
| AC-2      | `test/scout-handoff.test.js`, группа 2 | freshness matrix; changed requirements; missing body; explicit skip           | pending |
| AC-3      | `test/scout-handoff.test.js`, группа 3 | restart/retry; new context version; paired allowlist; no-scout regression     | pending |

## Verification

- Выполнить criterion-specific fixtures выше и проверки затронутых harness/brief/CLI модулей.
- Для persistence и запуска проверить повтор запроса, interruption и restart на durable boundaries.
- Проверить сценарий без scout и сохранение Task Contract/permissions.
- Пройти применимые repository gates и независимый review; для пилота приложить результаты реальных consumer прогонов.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит от завершённой [CLEW-124](./done/CLEW-124.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом. Карточка готова к выполнению как следующий шаг scout v0.

## Risks

Изменившийся код делает исходную карту потенциально устаревшей; Deep не должен автоматически считать её актуальной для всех последующих Stages.

## Blockers

None.

## Completion record

Not completed.
