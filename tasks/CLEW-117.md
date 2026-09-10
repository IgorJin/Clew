---
id: CLEW-117
title: Apply prune with quarantine and safe garbage collection
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-116, CLEW-107]
parallel_group: null
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-117 — Apply prune with quarantine and safe garbage collection

## Objective

Применять план очистки без удаления используемых blobs и с восстановлением после сбоя.

## User outcome

Очистка удаляет только разрешённые diagnostics и позволяет пережить сбой без потери нужного artifact.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Под блокировкой повторно проверять policy/state/ref/pin/reader versions; отсоединять только разрешённые diagnostic references.
- Вести durable deletion journal; помещать unreferenced blob в quarantine с grace period, затем удалять идемпотентно.
- Удалять disposable diagnostic rows только после consumer/rebuild proof; защищать новые writers/readers и export pins, обрабатывать orphan/temp отдельным age guard.

## Out of scope

Удаление пользовательских artifacts, native sessions, worktrees и full VACUUM.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Новые ссылки/pins, начатый export или continuation между preview/apply отменяют удаление; blob общего владельца остаётся доступен.
2. Crash на каждом шаге detach/quarantine/unlink и повтор prune продолжают операцию без удаления лишних файлов; grace period позволяет восстановление.
3. После prune канонические facts, Thread rebuild и resume эквивалентны исходным; event seq не переиспользуются и tombstone объясняет expired artifact.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence                   | Logical scenarios                                                   | Result  |
| --------- | ------------------------------------ | ------------------------------------------------------------------- | ------- |
| AC-1      | `test/artifact-gc.test.js`, группа 1 | GC race fixtures; reader/writer lease; shared refs; stale plan      | pending |
| AC-2      | `test/artifact-gc.test.js`, группа 2 | fault injection; retry prune; quarantine restore; stale temp writer | pending |
| AC-3      | `test/artifact-gc.test.js`, группа 3 | pruned recovery fixtures; projection rebuild; expired descriptor    | pending |

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

Зависит от [CLEW-116](./CLEW-116.md), [CLEW-107](./CLEW-107.md). Все должны быть done до ready. Ownership ограничен Scope; при изменении общего store/schema согласовать контракт с соседними карточками. Порядок всей очереди указан в архитектурном документе.

## Risks

Проверка references после удаления файла уже не предотвращает гонку.

## Blockers

None.

## Completion record

Not completed.
