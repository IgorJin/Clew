---
id: CLEW-111
title: Bounded event queries and HTTP pages
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-105, CLEW-109]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-111 — Bounded event queries and HTTP pages

## Objective

Ограничить event queries до загрузки и JSON.parse и предоставить cursor pagination.

## User outcome

Большая история доступна страницами с предсказуемым объёмом ответа.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить SQL queries/indexes по task, seq, type/class; after/limit/byteLimit с валидаторами и безопасными defaults.
- Возвращать nextCursor/high-watermark и bounded descriptor для legacy oversized row с отдельным доступом к телу.
- Перевести HTTP events/diagnostics queries и диагностическую CLI выдачу на страницы; определить resync после истечения истории без перенумерации seq.

## Out of scope

WebSocket и переработка Task Thread.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Страница соблюдает лимиты count/serialized bytes, а oversized legacy row не блокирует продвижение cursor.
2. Invalid/future/stale cursor и gaps имеют документированное поведение; параллельная вставка не пропускается при продолжении.
3. SQL ограничивает materialization до parse; query-plan/fixture доказывает отсутствие полной загрузки большой Task.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                        | Logical scenarios                                                  | Result  |
| --------- | ----------------------------------------- | ------------------------------------------------------------------ | ------- |
| AC-1      | `test/event-pagination.test.js`, группа 1 | HTTP page fixtures; boundary count/bytes; oversized first row      | pending |
| AC-2      | `test/event-pagination.test.js`, группа 2 | cursor fixtures; invalid; expired; deleted gaps; concurrent append | pending |
| AC-3      | `test/event-pagination.test.js`, группа 3 | SQL instrumentation and EXPLAIN; large synthetic history           | pending |

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

Зависит от [CLEW-105](./CLEW-105.md), [CLEW-109](./CLEW-109.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Обрезать массив после .all() недостаточно для ограничения RAM.

## Blockers

None.

## Completion record

Not completed.
