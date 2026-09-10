---
id: CLEW-112
title: WebSocket replay flow control
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

# CLEW-112 — WebSocket replay flow control

## Objective

Отправлять историю ограниченными пакетами и безопасно обслуживать медленных клиентов.

## User outcome

После reconnect пользователь получает актуальную историю без зависания от большого backlog.

## Context

Часть [плана жизненного цикла данных](../docs/TASK-DATA-LIFECYCLE.md). Рабочие defaults описаны там; релиз ещё не назначен, v0.10 сохраняет текущий объём. Эта карточка реализует один отдельный шаг, а не весь этап архитектуры.

## Scope

- Использовать bounded event queries в replay/broadcast и очередь socket с фиксированным пределом.
- Продвигать scan cursor через непубличные события; фиксировать только безопасный client resume point, гарантировать переход replay → live.
- Добавить согласованный snapshot/cursor resync; pause/disconnect при overflow без silent loss канонических публичных событий.

## Out of scope

Новый transport для Runner blobs и UI history rendering.

## Deliverables

- Реализация указанной границы и необходимые schema/migration changes.
- Criterion-specific automated fixtures и обновление документации реализованного поведения.

## Acceptance criteria

1. Public ordering и event IDs сохраняются при reconnect, gaps и непубличном хвосте; пустой replay не зацикливается.
2. Медленный или отключённый клиент не накапливает неограниченную очередь и не задерживает scheduler.
3. Snapshot watermark и live handoff не теряют события между запросом snapshot и подключением сокета; повторы дедуплицируются.

## Acceptance evidence

Пути ниже — запланированные тесты или расширения существующих; evidence ещё не получено.

| Criterion | Automated evidence              | Logical scenarios                                                     | Result  |
| --------- | ------------------------------- | --------------------------------------------------------------------- | ------- |
| AC-1      | `test/daemon.test.js`, группа 1 | WebSocket replay fixtures; private tail; reconnect cursor; duplicate  | pending |
| AC-2      | `test/daemon.test.js`, группа 2 | slow socket harness; bufferedAmount bound; disconnect                 | pending |
| AC-3      | `test/daemon.test.js`, группа 3 | snapshot/live race; retained-history expiration; idempotent reconnect | pending |

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

Продвижение cursor раньше гарантированной доставки может потерять события на reconnect.

## Blockers

None.

## Completion record

Not completed.
