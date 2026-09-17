---
id: CLEW-127
title: '[plugins][contracts] Plugin API v1, registry, resolver, DI-правило'
status: in_review
release: unassigned
priority: P1
size: M
depends_on: []
parallel_group: null
owner: null
updated: 2026-09-12
evidence_policy: v1
---

# CLEW-127 — [plugins][contracts] Plugin API v1, registry, resolver, DI-правило

## Objective

Зафиксировать минимальную инфраструктуру плагинов и DI-правило, чтобы runtime Codex/OpenCode позже вынимались без правок доменных сервисов. DI-постановка про `modelBin`/connection подтверждена владельцем 2026-09-11.

## User outcome

Новый runtime добавляется своим модулем + manifest + регистрацией; scheduler, роли, lifecycle и UI не получают новых веток по его имени.

## Context

Сейчас `codexBin` / `openCodeBin` / `openCodeUrl` / `models.*` / `--harness` зашиты в `src/config.js`, `src/scheduler.js`, `src/runner-execution.js`, `src/control-service.js`, `src/session-surface.js`, `src/daemon.js`. Предложение — в [`docs/PLUGIN-ARCHITECTURE.md`](../docs/PLUGIN-ARCHITECTURE.md), разделы 2–4. Релиз идёт параллельно со Scout (`123–126`) и storage (`105–122`), `v0.10` не блокируется.

## Scope

- Manifest: `id`, `version`, `apiVersion`, extension points + версии, `configSchema`, область (`controller` / `execution-host`), декларация ресурсов.
- `AgentRuntime` v1: `describe / probe / run / inspect? / reconcile? / prepareSurface? / listModels? / dispose`; `run` получает `runId`, `operationId`, brief, workspace, role, model selection, policy, output schema, resume-ref; результат — terminal status + session/turn refs + evidence candidates + нормализованный usage + `RuntimeError` с классом.
- Registry + resolver в composition root: уникальность ID (коллизия — ошибка), проверка connection/version/capability до исполнения, fake только по явному тестовому маршруту. Неизвестный/выключенный/несовместимый исполнитель — диагностируемая ошибка, не молчаливый fallback.
- DI-правило (подтверждено 2026-09-11): сервис получает готовый port через constructor injection; registry используется только в точке сборки, не как глобал. Запрет прямых импортов registry/resolver/concrete-runtime (`plugins/registry`, `plugins/resolver`, `plugins/codex`, `plugins/opencode`) в `scheduler / architect / review / control-service / runner-execution / session-surface / daemon`. Единственное исключение — переходный generic-мост `plugins/legacy.js` (удаляется в `CLEW-133`); поправка внесена в CLEW-128.
- Конфиг-правило: host-владелец задаёт пути модулей, binaries, credentials и allowlist подключений; project-конфиг из репозитория не расширяет host policy, секреты в project-конфиге запрещены.
- Про `modelBin` (решение подтверждено 2026-09-11): binary/endpoint — свойство **connection** на execution host, а не модели. Связка `роль → connection → модель`, модель валидируется в контексте connection. Отдельного `modelBin(enum модели)` не вводим; вместо `codexBin/openCodeBin/openCodeUrl` вводим connection-scoped `runtimeConfig { connectionId, pluginId, bin/endpoint, model }`, который резолвится через registry. Селектор runtime в ядре — connection ID; binary/endpoint задаёт только host-конфиг connection, project-конфиг их задать не может; enum доступных runtime — динамический allowlist registry, а не статический список в ядре. Старые `codexBin`/`CLEW_CODEX_BIN`/`--codex-bin` маппятся в legacy connection `codex-default` с `config.bin` и диагностикой.
- Schema fixtures: versioned JSON Schema + runtime validators + негативные fixtures (дубли ID, несовместимая версия, неподдержанная capability).

## Out of scope

- Перенос Codex/OpenCode реализаций (это `128/129`); Claude Code — исключён из эпика полностью.
- Role routing, doctor, UI wiring (это `130`); persistence/paired (`131`); телеметрия (`132`).
- Marketplace, hot reload, установка произвольных пакетов, сторонний frontend-код, отдельный процесс для стороннего кода.
- Live smoke внешних CLI — по требованию эпика не требуется; только fixtures + fake + unit.

## Deliverables

- `src/plugins/*` (или согласованное место): manifest schema + validators, registry, resolver, fake plugin, connection config schema.
- Compatibility facade в `harness.js` объявлен, но старые фабрики пока не удаляются.
- Fixtures протокольных ошибок + документация DI-правила и config precedence.

## Acceptance criteria

1. Неизвестный ID, дубль ID, несовместимые Plugin API / версия CLI, неподдержанная capability возвращают явную ошибку до исполнения; порядок загрузки конфликт не решает.
2. Fake runtime доступен только по явному тестовому маршруту; обычный запуск его подхватить не может.
3. Ни один новый код доменных сервисов не импортирует конкретный runtime напрямую; сборка идёт через registry в composition root (проверяется grep-тестом на запрещённые импорты).
4. Project-конфиг с секретом или с попыткой задать путь модуля/binary вне host policy отклоняется с объяснением.

## Acceptance evidence

| Criterion | Automated evidence                                                    | Logical scenarios                                                                                              | Result |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| AC-1      | `test/plugins-contracts.test.js`, группа 1 (8 тестов)                 | unknown id; duplicate id; incompatible api; unsupported capability                                             | pass   |
| AC-2      | `test/plugins-contracts.test.js`, группа 2 (2 теста)                  | default route without fake; explicit fake route                                                                | pass   |
| AC-3      | `test/plugins-contracts.test.js`, группа 3 (4 теста) + grep-gate в CI | scheduler/roles/control-service без прямых runtime-импортов; повторный resolve; свежие адаптеры после рестарта | pass   |
| AC-4      | `test/plugins-contracts.test.js`, группа 4 (3 теста)                  | secret in project config; module path in project config                                                        | pass   |

Проверено (rerun review 2026-09-12): `node --test test/plugins-contracts.test.js` — 17/17; `npm test` — 333/333; `node --test test/config.test.js` — 11/11 (добавлен регресс на real-path rejection); `npm run tasks:check` — 68/68; `npm run format:check` и `npm run lint` — чисто. Live smoke не гонялся по решению эпика.

## Verification

- Реализовать и запустить группы выше; записать команды перед review.
- Прогнать существующие unit-тесты затронутых модулей; live smoke не требуется по решению эпика.
- Для stateful paths: повторные resolve одного connection, рестарт с тем же registry — без дублей адаптеров.
- Перед завершением — общие quality gates + независимый review.

## Review record

- Verdict: pass (review agent 2026-09-12; owner может оспорить)
- Reviewer: opencode (independent counterexample review)
- Findings: review 2026-09-12:
  1. **Исправлено (medium):** `assertSafeProjectPluginConfig` был dead-code — ни разу не вызывался из `loadConfig`. AC-4 «module path/binary в project-конфиге отклоняется» проходил только через unit-тест самой функции, но реальный путь загрузки конфига пропускал host-level поля (`bin/endpoint/credential`) в секциях `agents/plugins/connections` (секреты ловились старым `assertSafeProjectConfig`). Вшит в `loadConfig` + регресс-тест в `config.test.js` («rejects project plugin config that smuggles host-level settings»).
  2. Подтверждено контрпримерами: grep-gate чист (в `architect/review` только комментарии); manifest-валидатор отклоняет string-entry в extensionPoints, неизвестный point, невалидный scope, non-semver version, non-string apiVersion; `validateConfigValue` отклоняет type-mismatch; неизвестные JSON-Schema keywords игнорируются намеренно (задокументировано в `validate-config.js`, ADR-0001).
  3. **Wording-расхождение (accepted, scope boundary):** AC-1 упоминает «версия CLI», но registry/manifest валидирует только Plugin API и версии extension points; внешняя версия CLI — зона `probe()` (реализовано и покрыто в 128/129). Evidence-сценарий корректно указывает только «incompatible api».
  4. Полный сьют 333/333, contracts 17/17, config 11/11, lint/prettier/tasks:check чисто.
     Self-review implementer (пункты 1–7 ниже сохранены).
- Findings: self-review implementer:
  1. Host-policy denial не был покрыт тестом при наличии кода — добавлен тест.
  2. `errorOf` helper после `assert.fail` имеет недостижимый `return null` — eslint чистый (`assert.fail` для линтера обычный вызов), оставлено как есть.
  3. Generic RPC `execute` механически не запрещён в `assertAgentRuntime` (только проверка required-методов) — правило зафиксировано в `docs/PLUGIN-DI.md` и ловится на review, как требует карточка.
  4. Facade в `harness.js` — комментарий + `LEGACY_HARNESS_PLUGIN_IDS` + re-export, поведения не меняет.
     Поправки из CLEW-128 (до независимого review):
  5. `validateRuntimeResult` разрешает `session.nativeSessionId: null` для незавершённых результатов (abort до создания native thread); покрыто тестом в группе 3.
  6. Grep-gate уточнён: запрещены импорты `plugins/registry|resolver|codex|opencode` и прямые биндинги `CodexHarness|CodexArchitect|CodexReviewer|codexLaunchError`; generic-мост `plugins/legacy.js` разрешён до CLEW-133.
  7. Поправка из CLEW-132: `registry.createAdapter` проверяет контракт по extension point манифеста (`AgentRuntime`/`TelemetrySink`), а не только AgentRuntime — registry изначально generic по дизайну 127.

## Dependencies and parallelization

Входных зависимостей нет. Блокирует `128, 129, 132`. Ownership: только новая инфраструктура + facade; реализации runtime не трогать.

## Risks

- Слишком общий RPC `execute(type, payload)` вместо типизированных port — запрещено этой карточкой, ловить на review.
- Соблазн протащить registry как глобал в сервисы.

## Blockers

None.

## Completion record

Not completed.
