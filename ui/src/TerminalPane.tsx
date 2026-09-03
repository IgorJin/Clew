import { useEffect, useRef, useState } from 'preact/hooks';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type TerminalFrame = {
  ch: 'terminal';
  type: 'opened' | 'mode' | 'data' | 'exited' | 'error';
  id: string;
  mode?: 'observing' | 'handoff' | 'interactive' | 'exited';
  data?: string;
  error?: string;
  exitCode?: number | null;
};

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

function decode(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

export function TerminalPane({
  terminalId,
  runId,
  agentSessionId,
  taskId,
  role,
  sessionId,
  onClose,
}: {
  terminalId: string;
  runId?: string | null;
  agentSessionId?: string | null;
  taskId?: string;
  role?: string;
  sessionId: string | null;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    'connecting' | 'working' | 'handoff' | 'attached' | 'exited' | 'error'
  >('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: {
        background: '#0b0e0e',
        foreground: '#e8ece9',
        cursor: '#b9f15a',
        selectionBackground: '#b9f15a33',
      },
    });
    const fit = new FitAddon();
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let exited = false;
    let interactive = false;
    let reconnectDelay = 250;
    const sendResize = () => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            ch: 'terminal',
            type: 'resize',
            id: terminalId,
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
    };
    const connect = () => {
      if (stopped) return;
      setState('connecting');
      const query = new URLSearchParams();
      if (runId) query.set('runId', runId);
      if (agentSessionId) query.set('agentSessionId', agentSessionId);
      if (taskId) query.set('taskId', taskId);
      if (role) query.set('role', role);
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal?${query}`,
      );
      socketRef.current = socket;
      socket.onopen = () => {
        reconnectDelay = 250;
      };
      socket.onmessage = (event) => {
        let message: TerminalFrame;

        try {
          message = JSON.parse(String(event.data)) as TerminalFrame;
        } catch {
          return;
        }

        if (message.ch !== 'terminal' || message.id !== terminalId) return;
        if (message.type === 'opened') {
          interactive = message.mode === 'interactive';
          setState(
            message.mode === 'observing'
              ? 'working'
              : message.mode === 'handoff'
                ? 'handoff'
                : 'attached',
          );
          window.setTimeout(sendResize, 0);
        } else if (message.type === 'mode') {
          interactive = message.mode === 'interactive';
          if (message.mode === 'interactive') setState('attached');
          else if (message.mode === 'handoff') setState('handoff');
          else if (message.mode === 'observing') setState('working');
        } else if (message.type === 'data' && message.data) terminal.write(decode(message.data));
        else if (message.type === 'exited') {
          exited = true;
          setState('exited');
          terminal.write(
            `\r\n\x1b[90m[Codex terminal exited${message.exitCode === null ? '' : `: ${message.exitCode}`} ]\x1b[0m\r\n`,
          );
        } else if (message.type === 'error') {
          setState('error');
          terminal.write(`\r\n\x1b[31m${message.error ?? 'Terminal error'}\x1b[0m\r\n`);
        }
      };
      socket.onclose = (event) => {
        socketRef.current = null;
        if (stopped || exited || event.code === 1000) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 4_000);
      };
      socket.onerror = () => setState('error');
    };

    terminal.loadAddon(fit);
    terminal.open(host.current);
    sendResize();
    const input = terminal.onData((data) => {
      if (interactive && socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ ch: 'terminal', type: 'data', id: terminalId, data: encode(data) }),
        );
    });
    const resizeObserver = new ResizeObserver(sendResize);

    resizeObserver.observe(host.current);
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      input.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [agentSessionId, role, runId, taskId, terminalId]);

  const closeTerminal = () => {
    socketRef.current?.close(1000, 'terminal panel hidden');
    onClose();
  };

  return (
    <section className="terminal-panel" aria-label="Live Codex terminal">
      <div className="terminal-panel-head">
        <div>
          <strong>Live Codex terminal</strong>
          <span>{sessionId ?? terminalId}</span>
        </div>
        <div className="terminal-panel-actions">
          <span className={`terminal-state terminal-state-${state}`}>{state}</span>
          <button className="text-button" onClick={closeTerminal}>
            Close terminal
          </button>
        </div>
      </div>
      <div className="terminal-host" ref={host} />
    </section>
  );
}
