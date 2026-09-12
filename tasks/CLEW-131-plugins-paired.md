---
id: CLEW-131
title: '[plugins][paired] Binding snapshots, миграция, Runner-совместимость'
status: planned
release: unassigned
priority: P1
size: M
depends_on: [CLEW-130]
parallel_group: null
owner: null
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-131 — [plugins][paired] Binding snapshots, миграция, Runner-совместимость

## Objective

Сохранять immutable binding каждого run и пережить рестарт/paired без дублей, минимальным расширением wire-контракта.

## User outcome

Run помнит свой runtime: plugin/version, API version, connection, host, CLI-версия, capability snapshot, модель, config fingerprint. Обновление/выключение плагина не ломает активный run.

## Context

Шаг `P4` из предложения. Про Runner v2 подробно: сейчас v1 знает только pre-shared credential + `execute` capability. Предложение v2 добавляет в registration безопасный inventory runtime-подключений Runner (какие plugin/connection/capabilities есть на этом хосте), а в lease offer — binding/требования запуска. Старый Runner v1 остаётся на legacy-маршруте; новые plugin-маршруты на нём явно недоступны. Здесь делаем slim: inventory + binding без ломки v1 и без multi-runner scheduler.

## Scope

- Binding snapshot до исполнения + проверка совместимости после рестарта; несовместимость = recovery required, без автопереключения на другой runtime.
- Миграция старых runs: неизвестная версия/модель → legacy unknown, без приписывания текущей версии плагина.
- Runner: registration inventory (без секретов), lease binding-поля, обновление schemas/allowlist/fixtures; stale-message fencing и запрет автодубля сохраняются. Нативные процессы и terminal surfaces остаются Runner-local.
- Disable/update плагина: активный run доживает на старом экземпляре, новые запуски блокируются.

## Out of scope

- Claude; marketplace; multi-runner scheduling; доставка модулей с Controller; передача credentials на Controller.
- Метрики/логи; workflow-конструктор.

## Deliverables

- Migration + binding store + Runner inventory/lease поля + fixtures negotiation (v1 legacy vs v2).

## Acceptance criteria

1. Local и paired дают эквивалентные канонические результаты на Codex/OpenCode по fixtures.
2. Crash/повтор сообщений на границах lease не создаёт дублирующий run.
3. Старые runs читаются как legacy unknown без потери истории; новый runtime не подменяет их молча.
4. Runner v1 продолжает работать по legacy-маршруту; plugin-маршруты на нём — явный отказ.

## Acceptance evidence

| Criterion | Automated evidence                 | Logical scenarios                                  | Result  |
| --------- | ---------------------------------- | -------------------------------------------------- | ------- |
| AC-1      | `test/plugins-paired.test.js` гр.1 | local vs paired equivalence (fixtures)             | pending |
| AC-2      | `test/plugins-paired.test.js` гр.2 | duplicate/reorder; restart before/after checkpoint | pending |
| AC-3      | `test/plugins-paired.test.js` гр.3 | legacy run migration; unknown version marks        | pending |
| AC-4      | `test/plugins-paired.test.js` гр.4 | v1 runner refuses plugin route explicitly          | pending |

## Verification

- Группы выше + регресс execution/lease тестов; live paired smoke не обязателен.
- Quality gates + review.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит от `130`. Блокирует `133`.

## Risks

- Расширение wire-контракта ломает v1; держать v2 аддитивным + negotiation fixtures.

## Blockers

None.

## Completion record

Not completed.
