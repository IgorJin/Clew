---
id: CLEW-124
title: Read-only scout execution and local result
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-123]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-124 — Read-only scout execution and local result

## Objective

Добавить явный scout run на существующем harness с небольшим локальным JSON-результатом.

## User outcome

Пользователь запускает исследование для Task, видит выбранную revision, preview результата и причины неполноты.

## Context

[Scout v0](../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Добавить CLI запуск/show/cancel scout attempt, используя текущий read-only harness path, timeout и output limits; один репозиторий на execution host.
- Подготовить read-only представление выбранного commit; явно отображать наличие неучтённых dirty changes. Проверять source paths/line ranges; запретить repo writes, install/test execution и сетевые инструменты.
- После redaction/validation атомарно публиковать versioned JSON в state directory, затем Task reference; хранить attempt ID, idempotency key и checksum. Файл пока не требует CLEW-107.

## Out of scope

Собственный agent loop, UI scout, фоновые обновления, persistent cross-task memory и Runner protocol changes.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Успешный запуск создаёт валидный результат и preview с существующими источниками; исходный checkout, Task Contract, workflow state и unrelated artifacts не изменяются.
2. Read-only/tool restrictions, timeout/cancel, corrupt output и oversized result дают явный failure/partial без публикации полного успешного результата.
3. Повтор запроса и restart вокруг запуска/file publish/reference commit не запускают duplicate attempt и не публикуют dangling reference; interrupted попытка требует явного нового запуска.

## Acceptance evidence

Пути — планируемые тесты; результаты пока не получены.

| Criterion | Automated evidence                       | Logical scenarios                                                             | Result  |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| AC-1      | `test/scout-execution.test.js`, группа 1 | CLI/fake harness; commit snapshot; dirty checkout warning; source validation  | pending |
| AC-2      | `test/scout-execution.test.js`, группа 2 | permission conformance; forbidden write/test/network; timeout; invalid output | pending |
| AC-3      | `test/scout-execution.test.js`, группа 3 | idempotency fixtures; interrupted run; atomic publish; restart                | pending |

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

Зависит от [CLEW-123](./CLEW-123.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом. Карточка остаётся planned до выбора очереди и завершения зависимостей.

## Risks

Read-only prompt сам по себе не ограничивает инструменты: runtime capability должна обеспечивать выбранный режим, иначе отказ до запуска.

## Blockers

None.

## Completion record

Not completed.
