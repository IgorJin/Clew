---
id: CLEW-132
title: '[plugins][telemetry] OTel traces как TelemetrySink, без метрик'
status: planned
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

| Criterion | Automated evidence                    | Logical scenarios                                      | Result  |
| --------- | ------------------------------------- | ------------------------------------------------------ | ------- |
| AC-1      | `test/plugins-telemetry.test.js` гр.1 | disabled path; no collector                            | pending |
| AC-2      | `test/plugins-telemetry.test.js` гр.2 | collector down; overflow; hung exporter; replay dedup  | pending |
| AC-3      | `test/plugins-telemetry.test.js` гр.3 | secret/prompt redaction; label bounds; usage preserved | pending |

## Verification

- Группы выше + регресс observability; live collector smoke не обязателен.
- Quality gates + review.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Зависит только от `127`; может идти параллельно с `128–130`. Блокирует `133` частично (sink-часть).

## Risks

- Ручная реализация OTLP wire вместо официального SDK — запрещена.

## Blockers

None.

## Completion record

Not completed.
