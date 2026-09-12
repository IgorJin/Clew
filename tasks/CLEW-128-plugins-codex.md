---
id: CLEW-128
title: '[plugins][codex] Вынос Codex runtime за AgentRuntime'
status: in_review
release: unassigned
priority: P1
size: M
depends_on: [CLEW-127]
parallel_group: plugins-runtime
owner: null
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-128 — [plugins][codex] Вынос Codex runtime за AgentRuntime

## Objective

Вынести существующий Codex (`app-server` + интерактивный CLI flow) за `AgentRuntime` без смены поведения: execution, approval, terminal, `Finish worker`, resume.

## User outcome

Worker/architect/reviewer/qa на Codex работают как раньше, но scheduler/роли не знают про Codex напрямую и не читают `codexBin`.

## Context

Сейчас Codex-специфика размазана: фабрики в `src/scheduler.js` + `src/runner-execution.js`, Codex-ветки в `src/architect.js` / `src/review.js`, создание endpoint и команд в сервисах, `codexBin` в `src/config.js` / `src/control-service.js` / `src/session-surface.js` / `src/daemon.js`. Карточка — шаг `P2` из [`docs/PLUGIN-ARCHITECTURE.md`](../docs/PLUGIN-ARCHITECTURE.md), только Codex (без Claude).

## Scope

- Новый модуль `clew.runtime.codex`: `run` (headless + interactive), interrupt/abort через signal, approval bridge, checkpoint/session identity, structured-output extraction с валидацией, usage-нормализация в канонические поля.
- `prepareSurface`: спецификация resume/open для существующего Codex flow; PTY-владение и жизненный цикл терминала остаются в Clew, один writer на workspace/run.
- Общие сервисы ролей принимают execution brief + схему и отдают выбранному runtime; Codex-ветки из `architect/review` удаляются.
- Удаление хардкода: `codexBin` как глобальное поле конфига больше не читается сервисами; binary резолвится из connection на execution host через DI. Старые `CLEW_CODEX_BIN` / `--codex-bin` маппятся в legacy connection с явной диагностикой, молчаливой смены runtime нет.
- Conformance: существующий `test/harness-conformance.test.js` гоняется против Codex-плагина через fixtures + fake clock; live smoke не требуется.

## Out of scope

- OpenCode (это `129`); Claude Code — вне эпика.
- Role→connection→model routing и doctor (это `130`); binding persistence (`131`).
- Новые capabilities сверх текущих; approval bridge для несуществующих режимов.

## Deliverables

- Плагин Codex + manifest + регистрация в composition root; удалённые Codex-импорты из scheduler/ролей; legacy-маппинг `codexBin`.
- Protocol fixtures Codex (детерминированные, в CI).

## Acceptance criteria

1. Quick/Standard/Deep на Codex дают те же канонические исходы, что до выноса (по fixtures, без live smoke).
2. `scheduler.js` / `runner-execution.js` / `architect.js` / `review.js` не импортируют Codex-модуль напрямую; исполнитель приходит через resolver.
3. Resume/interrupt/approval/terminal/Finish worker сценарии сохранены; открытие терминала не создаёт второй writer.
4. Старый `codexBin` превращается в legacy connection с диагностикой; конфликт старого `--harness` с новым `--connection` — явная ошибка.

## Acceptance evidence

| Criterion | Automated evidence                                                                                        | Logical scenarios                                                                | Result |
| --------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| AC-1      | `test/harness-conformance.test.js` без изменений (19/19 через facade) + `test/plugins-codex.test.js` гр.1 | quick/standard/deep; retry; interrupt; equivalence direct vs adapter             | pass   |
| AC-2      | grep-gate + `test/plugins-codex.test.js` гр.2                                                             | запрещённые прямые импорты; resolver injection (scheduler + runner)              | pass   |
| AC-3      | `test/plugins-codex.test.js` гр.3                                                                         | resume; abort; approval; structured output; single writer; probe; prepareSurface | pass   |
| AC-4      | `test/plugins-codex.test.js` гр.4                                                                         | legacy codexBin map; --harness vs --connection conflict                          | pass   |

Проверено: `node --test test/plugins-codex.test.js` — 16/16; `npm test` — 273/273 (baseline 240 до эпика + 17 из CLEW-127 + 16 новых); `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. Live CLI smoke не гонялся по решению эпика.

## Verification

- Группы выше + существующие backend-тесты затронутых модулей; live CLI smoke не гонять.
- Дубли событий/usage не удваивают счётчики; рестарт до/после checkpoint — явное recovery, без автодубля.
- Quality gates + review перед done.

## Review record

- Verdict: pending (ждёт независимого review владельца)
- Reviewer: unassigned
- Findings: self-review implementer:
  1. Перенос `CodexHarness` ловил два дефекта, оба пойманы сьютом и исправлены: ESM-цикл с TDZ (`APPROVAL_DECISION` на верхнем уровне) — вылечен выносом общей vocabulary в leaf-модуль `src/harness-events.js`; потерянный импорт `TURN_STATUS` — давал тихий таймаут вместо ошибки в `turn/completed`. После фикса conformance 19/19.
  2. Runner `createReviewer/createArchitect` раньше косвенно уважали `harnessFactory` (через `createHarness`); прямой перевод на resolver ломал тест. Сохранена точная семантика через `wrapCodexReviewer/wrapCodexArchitect` поверх `createHarness`.
  3. Сырой harness при синхронном throw из `spawnImpl` не маппит ENOENT (только async `error`-событие); адаптер нормализует оба тайминга в `CODEX_EXECUTABLE_NOT_FOUND`. Поведение ядра не менялось, разница зафиксирована тестом.
  4. Grep-gate уточнён до импортируемых биндингов (подстрока `CodexHarness` входит в легальное `resolveCodexHarness` из generic-моста).
  5. Interactive (`runInteractive`) покрыт существующими conformance-тестами через facade; новые тесты гоняют headless-путь адаптера.

## Dependencies and parallelization

Зависит от `127` (реализация готова, verdict pending). Параллельна с `129`. Блокирует `130`.

Решения по скоупу (зафиксированы реализацией):

- Legacy-ветки в scheduler/runner-execution сохранены как fallback через `plugins/legacy.js`; полное удаление — в `CLEW-133`. Продакшн-поведение не менялось (daemon/CLI без resolver → legacy-путь).
- Продакшн-wiring resolver (daemon/CLI, флаг `--connection`, doctor) — в `CLEW-130`; здесь только seam + mapping + правило конфликта.
- `codexBin` в `config.js`/doctor/session-surface не трогался — это `CLEW-130`.
- Поправка контракта `CLEW-127` (`nativeSessionId: null` для незавершённых) записана в карточку `127`.
- Общие константы событий вынесены в `src/harness-events.js` (побочный рефакторинг, покрыт полным сьютом).

## Risks

- Потеря approval/terminal нюансов Codex при переносе; ловить conformance-фикстурами.
- Остаточные чтения `config.codexBin` в обход resolver.

## Blockers

None.

## Completion record

Not completed.
