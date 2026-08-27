# Clew: что уже можно делать

Это практическая инструкция для release candidate `v0.1.0-rc.1`. Здесь описано только фактически реализованное и проверяемое поведение.

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
├── clew.sqlite       # tasks, plans, approvals, stages, runs, events
└── worktrees/        # worktrees, которыми владеет Clew
```

Event history append-only по смыслу: создание задачи, смена состояния, запуск harness, обнаруженное verification и ошибка сохраняются отдельно. Это позволяет объяснить, что происходило, без доступа к истории чата агента.

Перед записью event payload Clew рекурсивно скрывает значения полей вроде `authorization`, `apiKey`, `token`, `password` и inline Bearer credentials. Схема SQLite обновляется последовательными транзакционными миграциями; применённые версии записываются в `schema_migrations`, а SQL-артефакты лежат в `migrations/`.

Deep plan сохраняется в SQLite с номером версии до запуска stages. Если процесс Clew завершился посередине DAG, повторный `clew run TASK-ID --profile deep` переводит задачу в `RECOVERING`: завершённые stages восстанавливаются по persisted run/revision/evidence, оставшиеся `RUNNING` attempts получают статус `INTERRUPTED`, а незавершённая часть плана ставится в очередь заново.

### Architect and plan approval

Первый Deep run создаёт план через `fake` architect или отдельный read-only Codex turn. План проходит schema/DAG/integration validation, сохраняется со статусом `PENDING_APPROVAL`, а задача останавливается в `WAITING_FOR_HUMAN`. До решения человека Clew не создаёт ни одного worker worktree.

Команды `approve` и `reject` записывают actor, gate, причину, timestamp и решение в таблицу approvals и event history одной SQLite-транзакцией. Одобренный план получает статус `APPROVED` и переводит задачу в `PLAN_READY`; отклонённый план не может быть выполнен, а следующий run создаёт новую версию.

### Git worktree isolation

Quick run не работает в основном checkout. Clew создаёт отдельную ветку вида:

```text
ai/<task-id>-worker
```

и worktree внутри `.clew/worktrees/`. В результат запуска попадают путь, branch, base SHA и текущий revision. Результат worker stage фиксируется отдельным Git commit. В Deep flow commits независимых workers последовательно переносятся через cherry-pick в integration worktree.

Worktrees можно обслуживать из CLI:

```sh
node bin/clew.js worktree list
node bin/clew.js worktree remove /absolute/owned/path
node bin/clew.js worktree prune
```

`prune` удаляет только clean inactive worktrees. Активные run paths и dirty worktrees сохраняются.

Если commits конфликтуют, Clew прерывает cherry-pick, оставляет integration worktree в чистом диагностируемом состоянии, записывает событие `INTEGRATION_CONFLICT` и переводит integration stage и задачу в `FAILED`. Автоматического разрешения конфликтов пока нет.

### Harness boundary

Доменный код не знает протокол конкретного harness. Уже есть три реализации одного запуска:

- `fake` — детерминированный harness для локальной проверки и тестов;
- `codex` — machine-facing Codex app-server adapter;
- `opencode` — OpenCode HTTP adapter.

`fake` — единственный harness, который гарантированно работает без внешней настройки. Codex/OpenCode требуют запущенного сервера, авторизации и совместимого протокола; их live-совместимость должна быть проверена в конкретной среде.

Общий conformance suite проверяет для всех трёх adapters порядок и correlation lifecycle events. Codex fixture дополнительно проверяет native `threadId`/`turnId`, server-initiated approval с явным решением, официальный `turn/interrupt` и нормализованный timeout. Эти native IDs сохраняются в записи run. Approval-запросы native harness сохраняются в SQLite и видны через `status`, `show` и `events`; пока run ждёт решения, его можно подтвердить или отклонить из второго процесса:

```sh
node bin/clew.js approve-run TASK-ID:RUN-ID:900 --actor your-name
node bin/clew.js reject-run TASK-ID:RUN-ID:900 --actor your-name
```

При прямом использовании `CodexHarness` без callback по-прежнему действует безопасное решение `decline`.

Для Standard/Deep review можно отдельно выбрать native Codex reviewer:

```sh
node bin/clew.js run TASK-ID --profile standard --harness fake --review-harness codex
```

В этом режиме worker остаётся fake (удобно для проверки orchestration), а review-запрос отправляется в Codex app-server с read-only sandbox и `outputSchema`. Без доступного app-server запуск завершится диагностируемой ошибкой.

### State semantics

Clew различает:

```text
HARNESS_COMPLETED → VERIFYING → READY
```

Завершение turn означает только, что harness закончил работу. Задача становится `READY` после сохранения verification evidence и применения completion policy.

После перезапуска для Deep flow появляется отдельный переход:

```text
EXECUTING/FAILED → RECOVERING → EXECUTING
```

`STAGE_RECOVERED` означает, что Clew нашёл доказуемо завершённый run с revision и не запускал stage повторно. Если у stage нет сохранённого revision, recovery останавливается в `BLOCKED`, а не дублирует работу молча.

Чтобы прервать выполняющуюся задачу, нажмите `Ctrl-C` в активном процессе `clew run`. Native harness получает `AbortSignal`, задача переходит в `CANCELLED`, а активный run сохраняется как `INTERRUPTED`.

Из другого процесса можно создать persisted-запрос:

```sh
node bin/clew.js interrupt TASK-ID --actor your-name
```

Активный scheduler подхватит запрос и прервет текущий harness. Запрос и результат перехода доступны через `clew events TASK-ID`.

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

Важно: fake harness делает безопасную stage-specific fixture-запись `.clew-runs/<stage-id>.log` в worktree. Это демонстрация lifecycle, а не реализация refresh-token feature.

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

`doctor` проверяет Node.js, Git, точную совместимую версию CLI, Codex login и OpenCode `/global/health`. Без `--harness` native-проверки информационные; с `--harness codex|opencode` они обязательны и влияют на итоговый `ok`.

Поддерживаемые версии release candidate: Codex CLI/app-server `0.148.0`, OpenCode CLI/server `1.18.23`.

## Сценарий 6: создать и подтвердить Deep plan

Детерминированная локальная демонстрация без внешнего Codex:

```sh
node bin/clew.js run TASK-ID --profile deep --harness fake --architect fake
node bin/clew.js plan TASK-ID
node bin/clew.js approve TASK-ID
node bin/clew.js run TASK-ID --profile deep --harness fake
```

Первый `run` возвращает `WAITING_FOR_HUMAN` и `PLAN_APPROVAL_REQUIRED`. `plan` показывает JSON плана, номер версии, статус и историю решений. После `approve` второй `run` начинает DAG execution.

Для native architect:

```sh
node bin/clew.js run TASK-ID --profile deep --harness fake --architect codex
```

Architect использует отдельный Codex app-server turn с `readOnly: true` и JSON `outputSchema`. Worker при этом может оставаться `fake`. Нужен доступный и авторизованный `codex app-server`.

Чтобы отклонить план:

```sh
node bin/clew.js reject TASK-ID --reason "Разделить backend на два stage"
```

Следующий Deep run создаст новую версию плана и снова запросит подтверждение.

## Что означают профили сейчас

Названия профилей и базовая policy уже валидируются:

| Profile    | Сейчас можно ожидать                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quick`    | один worker; fake, Codex или OpenCode; `READY` требует passing verification evidence                                                                                        |
| `standard` | отдельный structured reviewer; blocking findings передаются в retry prompt; первый retry возобновляет session, повторный failure начинает fresh session                     |
| `deep`     | versioned architect plan, approval gate, DAG с `maxWorkers`, isolated worktrees, per-stage harness route, integration, broad verification, review, retry и restart recovery |

Для полностью детерминированной демонстрации используйте `quick --harness fake`; для реальной разработки сначала запустите соответствующий `doctor`.

## Конфигурация и хранение данных

Приоритет настроек: command flag → environment → project `.clew.json` → `~/.config/clew/config.json` → defaults. Поддерживаются `codexBin`, `openCodeBin`, `openCodeUrl`, `worktreeRoot`; соответствующие environment keys — `CLEW_CODEX_BIN`, `CLEW_OPENCODE_BIN`, `CLEW_OPENCODE_URL`, `CLEW_WORKTREE_ROOT`. Для разового запуска доступны `--codex-bin`, `--opencode-bin`, `--opencode-url`, `--worktree-root`.

Secrets запрещены даже во вложенных полях project config. Event payloads рекурсивно редактируются перед SQLite. База и raw normalized events остаются локальными до ручного удаления `.clew/`; clean inactive worktrees удаляются командой `worktree prune`, dirty и active сохраняются.

Следить за выполняющейся задачей можно без отдельного UI:

```sh
node bin/clew.js status TASK-ID --watch --interval 1000
```

## Явные ограничения v0.1

- автоматическое или human-assisted разрешение merge conflicts;
- автоматический выбор произвольной retry policy для неизвестных failure classes;
- возобновление середины уже прерванного native turn: Clew возобновляет session/thread и создаёт новый учтённый turn;
- автоматический запуск и управление жизненным циклом внешнего OpenCode server;
- dashboard UI;
- OpenTelemetry/Phoenix;
- PR/merge automation;
- runtime isolation портов, баз данных и контейнеров.

OpenCode transport `1.18.23` прошёл live create/session/SSE/failure проверку. Успешный model turn зависит от provider, настроенного внутри OpenCode; в release-signoff окружении provider `omlx` был недоступен, и Clew корректно сохранил внешний failure вместо ложного `READY`.

Это не скрытые ограничения: они вынесены в [RELEASE.md](./RELEASE.md) и post-v0.1 секцию [tasks.md](./tasks.md).

## Как развивать проект дальше

После `npm run check` выберите реальный use case и начните с `quick --harness codex`. Standard имеет смысл, когда нужен независимый review; Deep — когда работа действительно делится на несколько изолированных stages. Post-v0.1 идеи находятся в конце [`tasks.md`](./tasks.md).
