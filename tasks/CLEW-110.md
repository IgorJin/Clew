---
id: CLEW-110
title: Diagnostic quotas and write backpressure
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-106, CLEW-109]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-110 — Diagnostic quotas and write backpressure

## Objective

Остановить неограниченный рост diagnostics по bytes, числу событий и очереди записи.

## User outcome

Долгая задача соблюдает заданные budgets, а прекращение записи diagnostics заметно пользователю.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Применять Run/Task logical budgets к inline и blob до compression, а host physical admission — к уникальным и in-flight bytes.
- Объединять только disposable progress deltas; определить фиксированные queue/count bounds и flush на завершении/ошибке.
- Один раз отмечать exhaustion, прекращать raw diagnostics и сохранять canonical facts; disk pressure блокирует новые запуски и явно обрабатывает ENOSPC обязательной записи.

## Out of scope

Автоматическое удаление protected data ради жёсткого общего потолка.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Много мелких deltas и большой output не обходят budgets; параллельные writers не превышают quota через гонку reservations.
2. При exhaustion Run остаётся управляемым, lifecycle/permissions/usage не теряются из-за sampling; повтор ошибки не создаёт новый бесконечный log.
3. Рестарт восстанавливает counters, ENOSPC не публикует успешный переход без его durable записи, снижение pressure позволяет явное продолжение.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                         | Logical scenarios                                                      | Result  |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------- | ------- |
| AC-1      | `test/diagnostic-budget.test.js`, группа 1 | tiny-event flood; shared blob logical charging; parallel reservations  | pending |
| AC-2      | `test/diagnostic-budget.test.js`, группа 2 | queue bounds; coalescing flush; single exhaustion marker; error events | pending |
| AC-3      | `test/diagnostic-budget.test.js`, группа 3 | restart counters; injected ENOSPC; canonical failure; recovery         | pending |

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

Зависит от [CLEW-106](./CLEW-106.md), [CLEW-109](./CLEW-109.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Приложение не может гарантировать запись recovery marker на физически заполненном диске.

## Blockers

None.

## Completion record

Not completed.
