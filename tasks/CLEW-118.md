---
id: CLEW-118
title: SQLite maintenance after retention
status: planned
release: unassigned
priority: P1
size: S
depends_on: [CLEW-117]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-118 — SQLite maintenance after retention

## Objective

Освобождать SQLite/WAL место отдельной контролируемой maintenance-операцией.

## User outcome

Пользователь может вернуть свободные страницы SQLite диску в подходящий момент.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить report о freelist/WAL и поддерживаемом auto_vacuum mode; не включать полный rebuild при обычном prune.
- Разрешить bounded incremental vacuum только при совместимом режиме; для NONE документировать отдельный explicit maintenance rebuild.
- Проверять свободное место, writers/readers, busy timeout и exclusive owner; выводить фактически освобождённые bytes.

## Out of scope

Изменение политики хранения и автоматическая смена SQLite режима на старте daemon.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. NONE и INCREMENTAL обрабатываются различно; prune не запускает дорогой VACUUM автоматически.
2. Busy readers/WAL и недостаток места дают actionable refusal/defer, не останавливая корректную БД.
3. После разрешённого maintenance integrity checks, revisions, seq и restart state совпадают с исходными.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                           | Logical scenarios                                                  | Result  |
| --------- | -------------------------------------------- | ------------------------------------------------------------------ | ------- |
| AC-1      | `test/storage-maintenance.test.js`, группа 1 | SQLite mode fixtures; separate prune and maintenance commands      | pending |
| AC-2      | `test/storage-maintenance.test.js`, группа 2 | busy reader; low disk simulation; owner contention                 | pending |
| AC-3      | `test/storage-maintenance.test.js`, группа 3 | integrity/foreign-key check; before/after canonical digest; reopen | pending |

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

Зависит от [CLEW-117](./CLEW-117.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

VACUUM может требовать дополнительное место и блокировать writers.

## Blockers

None.

## Completion record

Not completed.
