# Clew: что уже можно делать

Это практическая инструкция для текущей версии `v0.1.0-alpha.1`. Здесь описано не всё, что задумано в архитектуре, а то, что уже можно запустить и проверить сегодня.

## Коротко

Clew сейчас — локальный CLI, который связывает одну development task с:

- формальным task contract;
- профилем выполнения;
- SQLite-хранилищем;
- этапом и попыткой запуска;
- Git worktree и branch;
- harness events;
- verification evidence;
- историей событий.

Главный рабочий сценарий уже готов: создать задачу → выделить отдельный worktree → запустить harness → сохранить evidence → получить честный статус `READY`.

## Что уже работает

### Task contract

У задачи есть обязательные поля:

- `id` — короткий безопасный идентификатор;
- `title`;
- `goal`;
- `acceptance` — один или несколько критериев с устойчивыми `id`;
- `profile` — `quick`, `standard` или `deep`;
- `risk` и `base_ref` — с безопасными значениями по умолчанию.

Контракт проверяется до записи в базу. Для строковых acceptance criteria IDs создаются автоматически как `AC-1`, `AC-2`, и так далее. Для объектной формы `id` обязателен.

### Local state and event history

После `clew init` создаётся:

```text
.clew/
├── clew.sqlite       # tasks, stages, runs, events
└── worktrees/        # worktrees, которыми владеет Clew
```

Event history append-only по смыслу: создание задачи, смена состояния, запуск harness, обнаруженное verification и ошибка сохраняются отдельно. Это позволяет объяснить, что происходило, без доступа к истории чата агента.

### Git worktree isolation

Quick run не работает в основном checkout. Clew создаёт отдельную ветку вида:

```text
ai/<task-id>-worker
```

и worktree внутри `.clew/worktrees/`. В результат запуска попадают путь, branch, base SHA и текущий revision. Worktree можно проверить и удалить через `GitWorktreeManager` из кода; CLI-команды для ручной уборки пока не добавлены.

### Harness boundary

Доменный код не знает протокол конкретного harness. Уже есть три реализации одного запуска:

- `fake` — детерминированный harness для локальной проверки и тестов;
- `codex` — machine-facing Codex app-server adapter;
- `opencode` — OpenCode HTTP adapter.

`fake` — единственный harness, который гарантированно работает без внешней настройки. Codex/OpenCode требуют запущенного сервера, авторизации и совместимого протокола; их live-совместимость должна быть проверена в конкретной среде.

### State semantics

Clew различает:

```text
HARNESS_COMPLETED → VERIFYING → READY
```

Завершение turn означает только, что harness закончил работу. Задача становится `READY` после сохранения verification evidence и применения completion policy.

## Установка и первая проверка

Требования:

- Node.js `22.5+`;
- Git `2.30+`;
- репозиторий должен иметь хотя бы один commit, если используется реальный worktree run.

Проверка самого проекта:

```sh
npm install
npm run check
```

`npm run check` запускает Prettier check, ESLint, тесты и синтаксическую проверку всех JavaScript-файлов.

## Сценарий 1: запустить готовый Quick flow

```sh
node bin/clew.js init

node bin/clew.js task create \
  --id AUTH-142 \
  --title "Refresh token rotation" \
  --goal "Make the previous refresh token invalid after rotation" \
  --accept "a new refresh token is issued" \
  --accept "replaying the previous token returns 401" \
  --profile quick \
  --risk high

node bin/clew.js run AUTH-142 --harness fake
node bin/clew.js status AUTH-142
node bin/clew.js events AUTH-142
```

Ожидаемый результат запуска содержит:

- `runId`;
- путь worktree;
- имя ветки;
- base SHA и revision;
- `state: READY`.

Важно: fake harness делает безопасную fixture-запись `.clew-execution.log` в worktree. Это демонстрация lifecycle, а не реализация refresh-token feature.

## Сценарий 2: создать контракт JSON

Файл `task.json`:

```json
{
  "id": "PAY-17",
  "title": "Add invoice export",
  "goal": "Export paid invoices as CSV",
  "profile": "standard",
  "risk": "medium",
  "base_ref": "main",
  "acceptance": [
    { "id": "AC-1", "criterion": "CSV contains invoice number and amount" },
    { "id": "AC-2", "criterion": "empty result is a valid CSV" }
  ]
}
```

Создание и просмотр:

```sh
node bin/clew.js task create --file task.json
node bin/clew.js task list
node bin/clew.js task show PAY-17
```

Все команды, которые выводят коллекции или состояние, печатают JSON. Это позволяет использовать Clew из shell-скриптов и других локальных инструментов.

## Сценарий 3: использовать Clew как task ledger

Даже если coding agent запускается вручную, Clew уже полезен как локальный журнал:

```sh
node bin/clew.js task create --id BUG-9 --title "Fix cache bug" --goal "Avoid stale permissions" --accept "permissions update is visible" --profile quick
node bin/clew.js task list
node bin/clew.js task show BUG-9
node bin/clew.js events BUG-9
```

Так можно отвечать на вопросы:

- какая задача существует;
- в каком она состоянии;
- какие stages и attempts были созданы;
- какой revision использовался;
- какие harness events и verification были записаны;
- почему запуск завершился ошибкой.

## Сценарий 4: проверить безопасность worktree

Автоматический тест делает это в отдельном временном Git-репозитории:

```sh
npm test -- --test-name-pattern="worktree"
```

`GitWorktreeManager`:

- вызывает Git через argument arrays, а не shell interpolation;
- проверяет, что путь удаления находится внутри Clew worktree root;
- не удаляет dirty worktree без `force`;
- очищает каталог, если `git worktree add` завершился ошибкой.

## Сценарий 5: диагностика окружения

```sh
node bin/clew.js doctor
```

Сейчас `doctor` проверяет наличие подходящего Node.js и Git. Это минимальная диагностика; проверки Codex/OpenCode/auth/version будут расширяться по мере live-интеграции.

## Что означают профили сейчас

Названия профилей и базовая policy уже валидируются:

| Profile    | Сейчас можно ожидать                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `quick`    | полностью рабочий путь с `fake`; native Codex boundary доступен через `--harness codex` при настроенном app-server |
| `standard` | контракт и профиль сохраняются; review/retry orchestration пока не завершены                                       |
| `deep`     | контракт и профиль сохраняются; architect/DAG/parallel integration пока не завершены                               |

Поэтому для демонстрации и локальной разработки используйте `quick --harness fake`.

## Что пока не следует считать готовым

Следующие возможности описаны в спецификации, но ещё не являются стабильной частью продукта:

- полноценный Codex app-server lifecycle с production-grade reconnect/resume;
- live OpenCode session/event stream во всех поддерживаемых версиях;
- native reviewer и structured review findings;
- retry routing по классификации failures;
- architect plan с human approval;
- настоящий multi-stage DAG и parallel workers;
- интеграция результатов worktrees и merge-conflict workflow;
- автоматическая cleanup policy для worktrees;
- dashboard UI;
- OpenTelemetry/Phoenix;
- PR/merge automation;
- runtime isolation портов, баз данных и контейнеров.

Это не скрытые ограничения: они вынесены в [RELEASE.md](./RELEASE.md) и [tasks.md](./tasks.md) как release gates или post-v0.1 backlog.

## Как развивать проект дальше

Рекомендуемый порядок:

1. Запустить `npm run check` и Quick fixture.
2. Проверить Codex app-server в конкретном локальном окружении.
3. Проверить OpenCode endpoint и зафиксировать поддерживаемую версию.
4. Добавить review/retry поверх уже существующего event model.
5. Только затем включать Deep/parallel flow и dashboard.

Если нужен следующий конкретный шаг, берите `CLEW-006` (Codex protocol spike), затем `CLEW-016` (production `CodexHarness`) и `CLEW-022` (Quick E2E acceptance fixture).
