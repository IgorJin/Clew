---
id: CLEW-131
title: '[plugins][paired] Binding snapshots, миграция, Runner-совместимость'
status: in_review
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

| Criterion | Automated evidence                 | Logical scenarios                                  | Result |
| --------- | ---------------------------------- | -------------------------------------------------- | ------ |
| AC-1      | `test/plugins-paired.test.js` гр.1 | local vs paired equivalence (fixtures)             | pass   |
| AC-2      | `test/plugins-paired.test.js` гр.2 | duplicate/reorder; restart before/after checkpoint | pass   |
| AC-3      | `test/plugins-paired.test.js` гр.3 | legacy run migration; unknown version marks        | pass   |
| AC-4      | `test/plugins-paired.test.js` гр.4 | v1 runner refuses plugin route explicitly          | pass   |

Проверено (rerun review 2026-09-12): `node --test test/plugins-paired.test.js` — 16/16; `npm test` — 333/333 (320 + 15 новых + 1 регресс-тест local parallel binding); `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. Live paired smoke не гонялся по решению эпика.

## Verification

- Группы выше + регресс execution/lease тестов; live paired smoke не обязателен.
- Quality gates + review.

## Review record

- Verdict: pass (review agent 2026-09-12; owner может оспорить)
- Reviewer: opencode (independent counterexample review)
- Findings: review 2026-09-12:
  1. **Исправлено (medium):** локальные параллельные stage-runs (`executeStage`) создавали run без binding (только single-worker и paired-путь снэпшотили). AC-1 «local vs paired equivalence» выполнялся частично. Добавлен `snapshotRunBinding` в `executeStage` + регресс-тест (git-worktree-поток, 16/16).
  2. Полный сьют 333/333, paired 16/16, lint/prettier/tasks:check чисто.
  3. Подтверждено контрпримерами: резюм того же run (continuation grant) перепроверяет binding; рестарт прерывает старый run (новый run — новый binding); fake/без-резолвера → legacy-unknown; disabled connection → RECOVERY_REQUIRED; дубли входящего lease deduplicated.
  4. Coverage binding: single-worker (local), paired stage, local parallel stage, continuation resume — покрыты; reviewer/architect runs создают только `agent_sessions` (identity через session refs из 130) — зафиксировано как accepted в implementer findings.
     Self-review implementer (пункты 1–6 ниже сохранены).
- Findings (self-review implementer):
  1. Протокол НЕ бампался до v2: версия wire осталась 1, `runtimeInventory`/`binding` — аддитивные опциональные поля; negotiation — через capability `plugin-bindings`. Без flag day, v1 runners интероперируют. Отклонение от предложения зафиксировано здесь сознательно.
  2. `cliVersion` в binding всегда `null`: версия CLI известна только через `probe()` (side effects), дёргать её при каждом создании run — неприемлемо; doctor владеет версиями. Зафиксировано как осознанное ограничение.
  3. Reviewer/architect executions не создают run-строк (только `agent_sessions`), поэтому binding-таблица покрывает worker/stage runs; identity ролевых запусков уже несёт connection через session refs (130).
  4. `saveRunBinding` — строгий INSERT (дубль = громкая ошибка, документирует write-once); corrupt-строки бросают исключение, отсутствие строки = legacy-unknown.
  5. Флейк в тесте эквивалентности (`createdAt` в мс иногда различался) — пойман, `createdAt` исключён из сравнения.
  6. Попутно: миграция v24, `CURRENT_SCHEMA_VERSION` 23→24, project-тест обновлён.

## Dependencies and parallelization

Зависит от `130`. Блокирует `133`.

## Risks

- Расширение wire-контракта ломает v1; держать v2 аддитивным + negotiation fixtures.

## Blockers

None.

## Completion record

Not completed.
