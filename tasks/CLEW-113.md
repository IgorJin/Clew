---
id: CLEW-113
title: Incremental Task Thread and summary projections
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-111]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-113 — Incremental Task Thread and summary projections

## Objective

Убрать полную историю из построения Task Thread и общих snapshots.

## User outcome

Открытие Task Thread и обновление списка задач не требуют чтения всех её логов.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Материализовать Thread items и summary по каноническим событиям с durable projection cursor в одной транзакции.
- Читать Task Thread страницами из projection; snapshot возвращает summaries без event history и полных bodies.
- Добавить bounded rebuild/catch-up и точечные queries для нужных summaries вместо многократного listEvents.

## Out of scope

UI virtualization и изменение бизнес-правил completion.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Инкрементальный и полный rebuild дают одинаковые item IDs, порядок, findings и operator decisions для Quick/Standard/Deep.
2. Сбой между событиями и projector commit/restart не теряет и не удваивает items; удалённые diagnostics не нужны для rebuild.
3. Thread page и snapshot не парсят всю Task, количество загруженных rows ограничено requested page/catch-up batch.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence              | Logical scenarios                                                                | Result  |
| --------- | ------------------------------- | -------------------------------------------------------------------------------- | ------- |
| AC-1      | `test/thread.test.js`, группа 1 | thread projection golden fixtures; profiles; human override                      | pending |
| AC-2      | `test/thread.test.js`, группа 2 | projection fault injection; duplicate delivery; rebuild after diagnostic removal | pending |
| AC-3      | `test/thread.test.js`, группа 3 | query instrumentation; large task; paginated thread and snapshot                 | pending |

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

Зависит от [CLEW-111](./CLEW-111.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Некоторые HARNESS события сейчас публичны и должны остаться в канонической projection.

## Blockers

None.

## Completion record

Not completed.
