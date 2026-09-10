---
id: CLEW-114
title: Versioned progress checkpoints
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-105, CLEW-107, CLEW-109, CLEW-126]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-114 — Versioned progress checkpoints

## Objective

Сохранять компактный воспроизводимый checkpoint на устойчивых границах исполнения.

## User outcome

После рестарта доступен проверяемый checkpoint того, что завершено и что предстоит сделать.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Добавить checkpoint schema/store: sourceCursor, task/plan versions, revisions, stage references, findings, pending decisions и nextAction.
- Использовать выводы пилота [CLEW-126](./CLEW-126.md): хранить выбранные RepositoryContext IDs/checksums и provenance отдельно от прогресса Task. Перенос локальной карты v0 в ArtifactStore сохраняет source revision и не требует повторного scout run.
- Публиковать checkpoints на существующих durable boundaries; обновлять current pointer через compare-and-swap/transaction, чтобы параллельные Stages не затёрли друг друга.
- Реализовать lazy rebuild из канонических данных, checksum, detection stale/corrupt и Stage references для превышения 64/256 КиБ.

## Out of scope

Prompt selection, cross-task memory и формальная QA-политика.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Повторная фиксация одной границы идемпотентна; rebuild на том же cursor даёт тот же payload hash, без LLM inference. Ссылки на выбранные scout contexts сохраняют ID/checksum/source revision после переноса из v0 файлов.
2. Перестановка завершения параллельных Stages и crash вокруг pointer commit сохраняют обе revisions и незакрытые decisions.
3. Oversized DAG/findings не обрезаются; current checkpoint bounded, legacy/stale/corrupt checkpoint восстанавливается или явно unavailable.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                           | Logical scenarios                                                    | Result  |
| --------- | -------------------------------------------- | -------------------------------------------------------------------- | ------- |
| AC-1      | `test/progress-checkpoint.test.js`, группа 1 | checkpoint golden fixtures; deterministic hash; replay same boundary | pending |
| AC-2      | `test/progress-checkpoint.test.js`, группа 2 | Deep parallel completion; pointer CAS; restart fault injection       | pending |
| AC-3      | `test/progress-checkpoint.test.js`, группа 3 | large DAG/findings; size bounds; legacy; corruption                  | pending |

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

Зависит от [CLEW-105](./CLEW-105.md), [CLEW-107](./CLEW-107.md), [CLEW-109](./CLEW-109.md) и пилота [CLEW-126](./CLEW-126.md). Все должны быть done до ready. Checkpoint contract уточняется по результатам scout v0; расширенная память репозитория не является зависимостью. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками.

## Risks

Checkpoint — производная канонических фактов, а не замена внутренней памяти harness.

## Blockers

None.

## Completion record

Not completed.
