---
id: CLEW-121
title: Storage controls and bounded history UI
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-106, CLEW-112, CLEW-113, CLEW-117]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-121 — Storage controls and bounded history UI

## Objective

Показать объём данных и безопасную очистку в UI, ограничив загружаемую историю.

## User outcome

Пользователь управляет объёмом, pins и очисткой из UI и просматривает большую историю страницами.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить Task/Project storage summary и состояния soft quota, paused diagnostics, missing/expired/Runner-local artifacts.
- Загружать Thread страницами с ограниченным cache, previews/body по явному запросу; сохранять порядок и selection при reconnect.
- Добавить pin/policy controls и preview → apply cleanup через существующий backend с объяснением protected bytes.

## Out of scope

Новый Task Canvas, полный storage dashboard и автоматическая cleanup schedule.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Большая Task не держит всю историю/все bodies в UI; старые страницы доступны через load-more и bounded cache.
2. Пользователь видит фактическую доступность artifact и причину quota, pin сохраняется после reload.
3. Cleanup preview соответствует backend; stale plan/возобновлённый Run дают повторный preview, не обход защиты и не изменение workflow.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence              | Logical scenarios                                                    | Result  |
| --------- | ------------------------------- | -------------------------------------------------------------------- | ------- |
| AC-1      | `ui/src/App.test.tsx`, группа 1 | UI large-history fixture; cache eviction; reconnect order; lazy body | pending |
| AC-2      | `ui/src/App.test.tsx`, группа 2 | storage summary; expired/missing/host unavailable; pin persistence   | pending |
| AC-3      | `ui/src/App.test.tsx`, группа 3 | UI cleanup flow; stale plan; running task; protected evidence        | pending |

## Verification

- Реализовать и запустить три группы проверок выше; записать конкретные команды/пути перед переводом в review.
- Запустить существующие проверки затронутых модулей; schema/migration changes проверять на fresh и upgraded store.
- Для stateful paths проверить durable boundaries, повторные запросы и рестарт согласно AC; не заменять эти доказательства одним общим зелёным suite.
- Перед завершением выполнить применимые repository quality gates и независимый review.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит от [CLEW-106](./CLEW-106.md), [CLEW-112](./CLEW-112.md), [CLEW-113](./CLEW-113.md), [CLEW-117](./CLEW-117.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

UI не должен обещать освободить logical bytes, если blob всё ещё нужен другой Task.

## Blockers

None.

## Completion record

Not completed.
