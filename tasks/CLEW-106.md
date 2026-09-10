---
id: CLEW-106
title: Storage usage report and counters
status: planned
release: unassigned
priority: P1
size: S
depends_on: [CLEW-105]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-106 — Storage usage report and counters

## Objective

Показывать измеренный объём хранения и источники роста командой storage status.

## User outcome

Пользователь видит, сколько места занимают его задачи и что именно растёт.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить read-only CLI/JSON report по Task, Run, Project и классу: logical bytes, unique physical bytes, counts, крупнейшие payloads.
- Отдельно показать SQLite/WAL/freelist, artifacts/temp и защищённые bytes; для недоступных native sessions/worktrees показывать unknown или отдельную оценку.
- Поддержать счётчики новых записей и ограниченную reconciliation старой базы без чтения всех payloads в JS.

## Out of scope

Очистка, сбор всех чужих native logs и UI.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Отчёт совпадает с fixture bytes и не удваивает физический размер одного blob с несколькими владельцами.
2. Legacy/пустая база и удалённый host дают явные zero/unknown значения; запрос не меняет Tasks и их timestamps.
3. Reconciliation идёт страницами; после рестарта и повторного запуска итог не задваивается.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                      | Logical scenarios                                                    | Result  |
| --------- | --------------------------------------- | -------------------------------------------------------------------- | ------- |
| AC-1      | `test/storage-report.test.js`, группа 1 | storage-report fixtures; shared blob; UTF-8; WAL and free pages      | pending |
| AC-2      | `test/storage-report.test.js`, группа 2 | CLI JSON fixtures; legacy; empty; unavailable host                   | pending |
| AC-3      | `test/storage-report.test.js`, группа 3 | counter reconciliation; repeated scan; bounded query instrumentation | pending |

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

Зависит от [CLEW-105](./CLEW-105.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Сумма логических размеров Tasks отличается от реального занятого диска при дедупликации.

## Blockers

None.

## Completion record

Not completed.
