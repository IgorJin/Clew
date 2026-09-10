---
id: CLEW-122
title: Task data lifecycle integration and scale acceptance
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-110, CLEW-115, CLEW-118, CLEW-119, CLEW-120, CLEW-121]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-122 — Task data lifecycle integration and scale acceptance

## Objective

Подтвердить ограниченный рост, восстановление и совместимость собранных частей.

## User outcome

Перед выпуском подтверждено, что большие задачи восстанавливаются и соблюдают измеряемые ограничения.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Собрать воспроизводимые normal/noisy/long-task fixtures и сравнить baseline с новой системой: disk, peak RSS, event count, page latency, queue maxima.
- Проверить 100 тысяч diagnostic events и большой streamed tool output: лимиты должны применяться по ходу обработки; обеспечить долгий fake run без live-model расходов.
- Прогнать существующие local/paired profile flows после prune/migration/export; оформить evidence и известные ограничения без релизного tag/publish.

## Out of scope

Новые функции, live benchmark произвольных моделей и назначение/публикация релиза.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Fixture демонстрирует ограниченные queue/page/cache allocations, соблюдение настроенных quotas и отсутствие роста peak RAM пропорционально всей истории; timing и hardware записаны.
2. Quick/Standard/Deep, явные override/continuation и interrupted/stale sessions сохраняют корректный результат после рестартов и удаления diagnostics.
3. Installed-package upgrade, artifact export/restore-check и local/paired allowlist проходят; каждая карточка имеет независимый review и evidence.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                           | Logical scenarios                                                                       | Result  |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| AC-1      | `test/task-data-lifecycle.test.js`, группа 1 | scale fixture metrics; 100k deltas; streamed large output; before/after baseline        | pending |
| AC-2      | `test/task-data-lifecycle.test.js`, группа 2 | integration recovery matrix; parallel Deep; override; retention/migration               | pending |
| AC-3      | `test/task-data-lifecycle.test.js`, группа 3 | installed-package acceptance; paired protocol; export verification; card evidence audit | pending |

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

Зависит от [CLEW-110](./CLEW-110.md), [CLEW-115](./CLEW-115.md), [CLEW-118](./CLEW-118.md), [CLEW-119](./CLEW-119.md), [CLEW-120](./CLEW-120.md), [CLEW-121](./CLEW-121.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Числа из одной локальной БД не являются производительным SLA; latency thresholds фиксируются для описанного fixture host.

## Blockers

None.

## Completion record

Not completed.
