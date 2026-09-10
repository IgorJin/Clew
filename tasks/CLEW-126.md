---
id: CLEW-126
title: Scout pilot and context contract refinement
status: planned
release: unassigned
priority: P1
size: S
depends_on: [CLEW-125]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-126 — Scout pilot and context contract refinement

## Objective

Проверить scout v0 на трёх представительных задачах и уточнить входной контракт для checkpoints.

## User outcome

Дальнейшая передача контекста проектируется на основании наблюдений за тем, что помогло архитектору и воркеру.

## Context

[Scout v0](../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Провести три прогона: локальный bug fix, изменение между модулями, неоднозначный scope; записать task/context IDs, revisions, consumers и использованные поля.
- Зафиксировать полезные/лишние/неверные сведения, пропущенные зависимости, context bytes/token estimate и usage/duration при доступности. Сами прогоны в изолированных fixtures; выпуск продуктовых изменений не входит.
- Добавить отчёт пилота в docs, поправить schema/fixtures и требования CLEW-114/115; реализация новой общей памяти не является условием завершения.

## Out of scope

Большой benchmark, доказательство общего ускорения, fixed release date и расширенный scout.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Для каждого сценария есть сохранённая карта и evidence её фактического потребления architect/worker; fake-only проверка JSON не выдаётся за реальный пилот.
2. Свежесть, явный отказ от scout, чтение источников и передача обязательных критериев проверены автоматическими регрессиями; внесённые поправки контракта проходят fixtures.
3. Отчёт содержит конкретные выводы keep/change по полям и сценариям, известные ограничения и согласованный вход CLEW-114/115; блокирующие дефекты минимального scout устранены до done.

## Acceptance evidence

Пути — планируемые тесты; результаты пока не получены.

| Criterion | Automated evidence                   | Logical scenarios                                                          | Result  |
| --------- | ------------------------------------ | -------------------------------------------------------------------------- | ------- |
| AC-1      | `test/scout-pilot.test.js`, группа 1 | pilot report + recorded consumer smoke; three task scenarios               | pending |
| AC-2      | `test/scout-pilot.test.js`, группа 2 | scout context/execution/handoff regression fixtures                        | pending |
| AC-3      | `test/scout-pilot.test.js`, группа 3 | updated schema fixtures; pilot findings resolution; downstream card review | pending |

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

Зависит от [CLEW-125](./CLEW-125.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом. Карточка остаётся planned до выбора очереди и завершения зависимостей.

## Risks

Полезность содержания требует просмотра реальных результатов; маленький пилот не даёт универсального SLA.

## Blockers

None.

## Completion record

Not completed.
