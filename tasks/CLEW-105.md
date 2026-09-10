---
id: CLEW-105
title: Storage classes and policy contracts
status: planned
release: unassigned
priority: P1
size: S
depends_on: []
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-105 — Storage classes and policy contracts

## Objective

Зафиксировать версионированные классы данных и проверяемые настройки хранения.

## User outcome

Настройки хранения валидируются заранее, а неизвестные данные остаются защищены от очистки.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Составить реестр event types и consumers: scheduler/recovery, completion, Thread, export, usage; нельзя классифицировать все HARNESS_* как удаляемые по префиксу.
- Определить artifact reference, retention class, byte accounting, диагностические лимиты и precedence defaults → Project → Task; protected data нельзя сделать disposable override-ом.
- Определить правила неизвестных типов, schema versioning и host identity; подготовить fixtures для следующих карточек.

## Out of scope

Реализация записи файлов, очистки и новое состояние workflow.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Каждый используемый event type имеет класс и список consumers; неизвестный тип сохраняется без права автоматического prune.
2. Невалидные, отрицательные и конфликтующие budgets отклоняются; bytes означают UTF-8, effective policy воспроизводима после рестарта.
3. Версионированные references различают доступный, истёкший, отсутствующий, повреждённый и Runner-local artifact без раскрытия host path.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                      | Logical scenarios                                                              | Result  |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------ | ------- |
| AC-1      | `test/storage-policy.test.js`, группа 1 | event registry coverage against producers; public HARNESS event; unknown event | pending |
| AC-2      | `test/storage-policy.test.js`, группа 2 | policy validators; Unicode; override precedence; restart serialization         | pending |
| AC-3      | `test/storage-policy.test.js`, группа 3 | reference schema fixtures; unsupported version; remote ownership               | pending |

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

Входных зависимостей нет. Карточка остаётся planned до выбора этой очереди для исполнения. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Ошибочная классификация удалит данные, которые recovery пока читает из событий.

## Blockers

None.

## Completion record

Not completed.
