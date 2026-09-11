---
id: CLEW-123
title: Scout context contract and fixtures
status: done
release: unassigned
priority: P1
size: S
depends_on: []
parallel_group: null
owner: codex
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-123 — Scout context contract and fixtures

## Objective

Определить минимальный RepositoryContext v1 для исследования одного репозитория под одну задачу.

## User outcome

Пользователь получает понятную карту с источниками и неизвестными областями; она имеет проверяемую идентичность и актуальность.

## Context

[Scout v0](../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Добавить schema/runtime validator результата и request: task/project identity, contract fingerprint, revision, scope, components, relationships, checks, observations, unknowns, provenance.
- Задать предел 64 КиБ UTF-8 и численные bounds коллекций/полей; различать complete/partial, observed/inferred и причину omissions.
- Определить stable context ID, checksum без самоссылки, relative source references, stale/unsupported handling и fake fixtures для consumers.

## Out of scope

Harness execution, полная память репозитория, индексы/embeddings и новый ArtifactStore.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Валидные complete/partial карты проходят schema/runtime validation; unsupported version, переполнение UTF-8 и выходящие за repo root ссылки отклоняются.
2. Вывод о проверках отделён от evidence выполнения; hypotheses/unknowns не подменяют факты или инструкции Task.
3. Одинаковое нормализованное содержимое даёт воспроизводимый checksum; Task/repo/revision mismatch определяется без нового запуска агента.

## Acceptance evidence

| Criterion | Automated evidence                     | Logical scenarios                                                  | Result |
| --------- | -------------------------------------- | ------------------------------------------------------------------ | ------ |
| AC-1      | `test/scout-context.test.js`, группа 1 | schema fixtures; Unicode; size and collection limits; invalid refs | pass   |
| AC-2      | `test/scout-context.test.js`, группа 2 | observed/inferred fixtures; recommended tests vs executed evidence | pass   |
| AC-3      | `test/scout-context.test.js`, группа 3 | deterministic fingerprint/checksum; changed Task; changed revision | pass   |

## Verification

- Выполнить criterion-specific fixtures и проверку JSON artifacts.
- Проверить сценарий без scout и сохранение Task Contract/permissions полным regression suite.
- Пройти repository gates и counterexample-oriented review. Persistence, запуск, interruption и restart проверяются в CLEW-124, а реальные consumer прогоны — в CLEW-125/126.

## Review record

- Verdict: pass
- Reviewer: Codex counterexample-oriented implementation review, 2026-09-11
- Findings: Проверены подмена checksum/contextId, unsupported version, изменённые Task/Project/repo/revision, Unicode overflow, выход из repo root, несовпадающая source revision, отсутствующие evidence/omission и попытка записать результат выполнения в recommended check. Блокирующих замечаний не осталось.

## Dependencies and parallelization

Входных зависимостей нет; это первая завершённая карточка scout очереди. Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 можно уточнять и реализовывать CLEW-114 → 115; независимые storage задачи могут выполняться рядом.

## Risks

Карта фиксирует найденное в конкретном снимке, не гарантируя полноту знания о репозитории.

## Blockers

None.

## Completion record

RepositoryContext v1 реализован в `src/scout-context.js`; request/result schemas и complete/partial consumer fixtures включены в published package и подтверждены `npm pack --dry-run --json`. Полный `npm run check` проходит: 101 UI tests; 248 backend tests total, 238 pass, 10 managed-sandbox loopback skips, 0 fail.
