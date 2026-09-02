# Интерактивный терминал worker’а

## Что требовалось

При нажатии `Run task` worker должен сразу работать в настоящем Codex TUI. Пользователь должен видеть ход работы, отвечать на вопросы агента и подтверждать его запросы прямо в терминале. UI только отображает этот PTY; он не должен запускать второй Codex turn.

## Первоначальная проблема

Старый flow сначала запускал headless App Server через `thread/start` и `turn/start`, а кнопка `Open live terminal` позже пыталась подключить TUI к тому же thread. Codex разрешает только одного активного writer на thread, поэтому во время `Stage worker run started` появлялась ошибка `already has an active writer`. После окончания headless turn writer освобождался, и терминал начинал открываться — это маскировало ошибку архитектуры.

## Принятое решение

1. Daemon создаёт App Server на Unix socket.
2. `CodexHarness.runInteractive()` запускает единственный worker TUI через `node-pty`:
   `codex --remote <socket> ... <task prompt>`.
3. TUI получает `workspace-write` (или `read-only`, если это явно задано) и сам выполняет turn.
4. `TerminalSessionManager` проксирует вывод PTY в xterm и ввод из xterm обратно в тот же PTY.
5. UI автоматически открывает терминал, когда snapshot видит активную terminal session. Дополнительный polling закрывает race, когда событие запуска пришло раньше, чем PTY успел зарегистрироваться.
6. Параллельный read-only `CodexTurnMonitor` использует отдельный stdio App Server только для `thread/list`/`thread/read`. Он не подключается к live socket и не становится writer’ом.
7. Когда persisted turn получает `completed`, Clew сохраняет native thread/turn ID и финальный `agentMessage`, публикует `HARNESS_TURN_WAITING`, а TUI продолжает ждать оператора.
8. `Finish worker` останавливает PTY. После этого Clew ещё раз читает сохранённый thread, сохраняет результат и запускает verification.

## Важные гонки native thread

- TUI создаёт native thread не одновременно с PTY. Если первый `thread/list` пуст, monitor обязан продолжать discovery на следующих poll, а не завершаться после первой ошибки.
- До discovery Clew использует только временный correlation ID вида `codex-<uuid>`. Такой ID нужен для раннего terminal attach, но никогда не передаётся в `codex resume`.
- Codex CLI 0.148 может показывать TUI-owned активный turn независимому reader как `interrupted`, пока writer ещё работает. Для живого PTY это промежуточное состояние трактуется как `running`; достоверный `completed` приходит после финального ответа, а реальный exit/interruption контролирует PTY lifecycle.
- Ключ дедупликации running-state не должен зависеть от ID промежуточных commentary messages. Иначе каждый новый комментарий создаёт ложное повторное lifecycle-событие.

## Почему reader не использует `app-server proxy --sock`

В Codex CLI 0.148 команда `app-server proxy --sock` проксирует stdio-байты в control socket с WebSocket handshake. Для Unix transport, поднятого через `app-server --listen unix://...`, это приводило к `invalid token` и timeout. После завершения TUI безопаснее поднять отдельный `codex app-server` на stdio и прочитать сохранённый thread без нового turn.

## UI и CLI правила

- `Run task` — единственная кнопка старта для обычной задачи; старый `Explain next step` и browser `confirm()` не используются.
- `Finish worker` — явная граница между интерактивной работой и автоматической verification.
- Закрытие панели терминала не завершает worker.
- `clew run TASK` через живой daemon использует тот же интерактивный маршрут.
- `CLEW_CODEX_OPEN_DESKTOP=true` только дополнительно открывает Codex Desktop; embedded CLI terminal создаётся всегда.

## Диагностика долгого старта

Длинный старт обычно вызван самим Codex CLI: он загружает plugins/MCP и пытается обновить модели или подключиться к `chatgpt.com`. Это не связано с размером `Goal`. Prompt сокращён: повторяющийся `Goal` убран, оставлены название, acceptance и короткие инструкции для интерактивной работы. Сетевые сообщения вроде `failed to refresh available models`, `MCP startup incomplete` и TLS/WebSocket errors следует проверять отдельно от Clew terminal lifecycle.

## Регрессионные проверки

- UI проверяет прямой `Run task`, отсутствие approval-кнопки worker’а и `Finish worker`.
- Harness проверяет, что интерактивный путь не вызывает `thread/start` или `turn/start` через Clew proxy.
- Scheduler проверяет передачу `runId` и live endpoint в Quick Codex worker.
- Terminal manager проверяет `waitForFinish()` и остановку PTY.
- End-to-end цикл: `Run task → Live Codex terminal → Finish worker → Ready`.
- Startup-race: первый `thread/list` пуст, следующий находит созданный TUI thread.
- Recovery: временный `codex-<uuid>` не используется как native resume ID.
- External-writer snapshot: промежуточный `interrupted` не создаёт ложный alert; финальный `completed` создаёт один waiting-event.

При дальнейших изменениях терминальной подсистемы сначала проверьте этот порядок владения writer’ом и не возвращайте headless turn перед TUI.
