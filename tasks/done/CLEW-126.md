---
id: CLEW-126
title: Scout pilot and context contract refinement
status: done
release: unassigned
priority: P1
size: S
depends_on: [CLEW-125]
parallel_group: null
owner: codex
updated: 2026-09-12
evidence_policy: v1
---

# CLEW-126 — Scout pilot and context contract refinement

## Objective

Проверить scout v0 на трёх представительных задачах и уточнить входной контракт для checkpoints.

## User outcome

Дальнейшая передача контекста проектируется на основании наблюдений за тем, что помогло архитектору и воркеру.

## Context

[Scout v0](../../docs/SCOUT.md) проверяет минимальную карту контекста до фиксации [checkpoints](../../docs/TASK-DATA-LIFECYCLE.md). Дальнейшее расширение scout запланировано отдельно; текущие карточки не определяют архитектуру общей памяти навсегда. Релиз не назначен, v0.10 остаётся текущим мини-релизом.

## Scope

- Провести три прогона: локальный bug fix, изменение между модулями, неоднозначный scope; записать task/context IDs, revisions, consumers и использованные поля.
- Зафиксировать полезные/лишние/неверные сведения, пропущенные зависимости, context bytes/token estimate и usage/duration при доступности. Сами прогоны в изолированных fixtures; выпуск продуктовых изменений не входит.
- Добавить отчёт пилота в docs, поправить schema/fixtures и требования CLEW-114/115; реализация новой общей памяти не является условием завершения.

## Out of scope

Большой benchmark, доказательство общего ускорения, fixed release date и расширенный scout.

## Deliverables

- Реализация описанного результата, CLI/schema changes по Scope.
- Автоматические fixtures с конкретным evidence для каждого критерия и обновлённая документация.

## Acceptance criteria

1. Для каждого сценария есть сохранённая карта и evidence её фактического потребления architect/worker; fake-only проверка JSON не выдаётся за реальный пилот.
2. Свежесть, явный отказ от scout, чтение источников и передача обязательных критериев проверены автоматическими регрессиями; внесённые поправки контракта проходят fixtures.
3. Отчёт содержит конкретные выводы keep/change по полям и сценариям, известные ограничения и согласованный вход CLEW-114/115; блокирующие дефекты минимального scout устранены до done.

## Acceptance evidence

Пути и результаты зафиксированы ниже.

| Criterion | Automated evidence                   | Logical scenarios                                                          | Result |
| --------- | ------------------------------------ | -------------------------------------------------------------------------- | ------ |
| AC-1      | `test/scout-pilot.test.js`, группа 1 | pilot report + recorded consumer smoke; three task scenarios               | pass   |
| AC-2      | `test/scout-pilot.test.js`, группа 2 | scout context/execution/handoff regression fixtures                        | pass   |
| AC-3      | `test/scout-pilot.test.js`, группа 3 | updated schema fixtures; pilot findings resolution; downstream card review | pass   |

## Verification

- `node --test --test-concurrency=1 test/scout-pilot.test.js` — 3 pass, 0 fail; три карты опубликованы и фактически потреблены Scheduler/Execution Brief paths.
- `node --test --test-concurrency=1 test/scout-context.test.js test/scout-execution.test.js test/scout-handoff.test.js test/execution-brief.test.js` — 25 pass, 0 fail.
- `npx eslint test/scout-pilot.test.js` и Prettier для затронутых JSON/JS/Markdown — pass; schema/fixture JSON проверяются `test/schema-artifacts.test.js`.
- Пилот проверяет explicit no-scout, stale contract, source references, Task Contract/permissions и provenance; provider usage для fixture adapter оставлен `null`, без fabricated metrics.

## Review record

- Verdict: pass
- Reviewer: Codex counterexample-oriented implementation review, 2026-09-12
- Findings: Проверены три scenario classes, сохранение карт, реальное потребление architect/worker brief paths, stale/no-scout fallback, source provenance, partial unknowns/omissions, schema fixture и downstream 114/115 inputs. Блокирующих дефектов минимального scout не обнаружено.

## Dependencies and parallelization

Зависит от завершённой [CLEW-125](./CLEW-125.md). Не зависит от CLEW-105–122. После 123 → 124 → 125 → 126 уточнены входы для CLEW-114 → 115; независимые storage задачи могут выполняться рядом.

## Risks

Полезность содержания требует просмотра реальных результатов; маленький пилот не даёт универсального SLA.

## Blockers

None.

## Completion record

Пилот и контрактные выводы зафиксированы в [отчёте](../../docs/CLEW-126-REPORT.md), fixture-сценариях [`fixtures/scout/pilot.v1.json`](../../fixtures/scout/pilot.v1.json) и [`test/scout-pilot.test.js`](../../test/scout-pilot.test.js). Для каждого сценария сохранены context ID, checksum, revision, selected sections, consumer roles, source evidence, context bytes и approximate token estimate. Контракт оставляет checks рекомендациями, сохраняет partial/unknown/omission markers и передаёт в checkpoint отдельные context references; usage provider остаётся неизвестным до live acceptance.
