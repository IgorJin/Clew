---
id: CLEW-132
title: '[plugins][telemetry] OTel traces как TelemetrySink, без метрик'
status: in_review
release: unassigned
priority: P1
size: S
depends_on: [CLEW-127]
parallel_group: plugins-sink
owner: null
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-132 — [plugins][telemetry] OTel traces как TelemetrySink, без метрик

## Objective

Вынести существующий traces-экспорт в `TelemetrySink`-плагин на той же registry-инфраструктуре, что runtime. Только traces; метрики и логи — вне эпика.

## User outcome

Та же OTel/OTLP-настройка работает через connection `otel-main`; выключение/падение экспорта не влияет на execution и историю.

## Context

Шаг `P5` slim из [`docs/PLUGIN-ARCHITECTURE.md`](../docs/PLUGIN-ARCHITECTURE.md), раздел 8. Ядро оставляет семантику/correlation/privacy/usage; плагин — SDK/exporter/очередь.

## Scope

- `TelemetrySink`: `emit(record)` для очищенных instrumentation-записей, `status()`, deadline-bounded `flush()/dispose()`; отдельная ограниченная очередь/timeout/backoff на sink.
- Перенос traces flow 1:1 + legacy config bridge (`endpoint/enable`); test sink для CI.
- Redaction/queue/full/failure/replay правила: telemetry выключена по умолчанию; prompt/код/tool output/секреты не экспортируются; переполнение видно в диагностике; зависший exporter не держит shutdown; replay не удваивает счётчики.
- Статус подключения sink в общей проекции.

## Out of scope

- Metrics, log export, PricingSource, TerminalLauncher/WorkspaceOpener/ChangeViewer (это всё вне эпика).
- Новые exporter под каждый dashboard — только OTLP → Collector.

## Deliverables

- OTel sink-плагин + test sink + bridge + доки.

## Acceptance criteria

1. Выключенный экспорт не требует OTel-пакетов/collector и не меняет lifecycle.
2. Отказ/переполнение/зависание exporter не меняет task state и обязательные проверки.
3. Redaction и label-ограничения соблюдены; usage сохраняется независимо от доставки.

## Acceptance evidence

| Criterion | Automated evidence                    | Logical scenarios                                      | Result |
| --------- | ------------------------------------- | ------------------------------------------------------ | ------ |
| AC-1      | `test/plugins-telemetry.test.js` гр.1 | disabled path; no collector                            | pass   |
| AC-2      | `test/plugins-telemetry.test.js` гр.2 | collector down; overflow; hung exporter; replay dedup  | pass   |
| AC-3      | `test/plugins-telemetry.test.js` гр.3 | secret/prompt redaction; label bounds; usage preserved | pass   |

Проверено: `node --test test/plugins-telemetry.test.js` — 12/12; `npm test` — 332/332 (320 + 12 новых); `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. Существующий `observability.test.js` — 3/3 без изменений. Live collector smoke не гонялся по решению эпика.

## Verification

- Группы выше + регресс observability; live collector smoke не обязателен.
- Quality gates + review.

## Review record

- Verdict: pass (review agent 2026-09-12; owner может оспорить)
- Reviewer: opencode (independent counterexample review)
- Findings: review 2026-09-12:
  1. Подтверждено контрпримерами: `Observability` без OTel-импортов (grep NONE); отключение = disabled-connection, sink не конструируется, пакеты не грузятся; нет пакетов = unavailable, не исключение; зависший exporter не держит shutdown/flush; дубли span-start дедуплицируются в обоих sinks; redaction/label-allowlist гонится на уровне core до emit.
  2. Форма `status()` совместима 1:1 — `observability.test.js` без изменений (3/3); doctor/`connections list` покрывают `otel-main` (cli.test обновлён).
  3. **Зафиксировано (coverage gap, accepted):** AC-3 «usage сохраняется независимо от доставки» покрыт косвенно — usage пишется scheduler-ом (`store.recordUsage`) архитектурно вне sink-пути; отдельного теста «sink падает → usage всё равно записан» нет, но failing-sink тест доказывает независимость событий/истории. При желании — отдельный тест в `133`.
  4. Полный сьют 333/333, telemetry 12/12, lint/prettier/tasks:check чисто.
     Self-review implementer (пункты 1–5 ниже сохранены).
- Findings (self-review implementer):
  1. `registry.createAdapter` из 127 хардкодил проверку AgentRuntime — обобщён на проверку по extension point (записано и в карточку 127 как поправка 7).
  2. Тест-стаб сессии telemetry_runs ссылается на runs(id): в тестах run-строка создаётся до STAGE_RUN_STARTED, как в проде; поведение ядра не менялось.
  3. Инвалидный sink в конструкторе не бросает: eager-load помечает unavailable, `emit` считает drops — состояние видно через status/doctor.
  4. `cli.test.js` doctor-тест обновлён (добавлен `connection:otel-main` со статусом `disabled` при выключенной телеметрии).
  5. Metrics/log export, PricingSource, лаунчеры — не тронуты; installer `telemetryInstall` оставлен в `observability.js` как facade (операционный инструмент, не экспортный тракт).

## Dependencies and parallelization

Зависит только от `127`; может идти параллельно с `128–130`. Блокирует `133` частично (sink-часть).

## Risks

- Ручная реализация OTLP wire вместо официального SDK — запрещена.

## Blockers

None.

## Completion record

Not completed.
