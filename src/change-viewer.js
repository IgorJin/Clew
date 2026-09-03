import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const CHANGE_VIEWER_RESULT_VERSION = 1;

function unavailable(viewer, reason, code = 'VIEWER_UNAVAILABLE', extra = {}) {
  return {
    version: CHANGE_VIEWER_RESULT_VERSION,
    state: 'unavailable',
    viewer,
    reason,
    code,
    ...extra,
  };
}

function validateWorkspace(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace))
    throw new Error('workspace must be an absolute path');
  if (!existsSync(workspace) || !statSync(workspace).isDirectory())
    throw new Error(`workspace does not exist: ${workspace}`);

  return resolve(workspace);
}

function launchCommand(command, workspace, launcher) {
  const args = [workspace];

  try {
    if (!launcher) {
      const lookup = process.platform === 'win32' ? 'where' : 'which';

      execFileSync(lookup, [command], { stdio: 'ignore' });
    }
    const child =
      launcher?.(command, args, {
        cwd: workspace,
        shell: false,
        stdio: 'ignore',
        detached: true,
      }) ?? spawn(command, args, { cwd: workspace, stdio: 'ignore', detached: true });

    if (!child) return unavailable(command, 'no viewer launcher is available', 'LAUNCHER_MISSING');
    child.on?.('error', () => {});
    child.unref?.();

    return { state: 'opened', command: [command, ...args], pid: child.pid ?? null };
  } catch (error) {
    return unavailable(command, error instanceof Error ? error.message : 'viewer failed to start');
  }
}

export class CommandChangeViewer {
  constructor({ id, command, launcher = null } = {}) {
    this.id = id;
    this.command = command;
    this.launcher = launcher;
    this.fallback = true;
  }

  open({ workspace }) {
    let resolved;

    try {
      resolved = validateWorkspace(workspace);
    } catch (error) {
      return unavailable(this.id, error.message, 'WORKSPACE_INVALID');
    }
    const result = launchCommand(this.command, resolved, this.launcher);

    return { ...result, viewer: this.id, workspace: resolved };
  }
}

export class WorktreePathViewer {
  constructor({ copy = null, platform = process.platform } = {}) {
    this.id = 'worktree-path';
    this.copy = copy;
    this.platform = platform;
    this.fallback = false;
  }

  open({ workspace }) {
    let resolved;

    try {
      resolved = validateWorkspace(workspace);
    } catch (error) {
      return unavailable(this.id, error.message, 'WORKSPACE_INVALID');
    }
    try {
      if (this.copy) this.copy(resolved);
      else {
        const command =
          this.platform === 'darwin' ? 'pbcopy' : this.platform === 'win32' ? 'clip' : 'xclip';
        const args = this.platform === 'linux' ? ['-selection', 'clipboard'] : [];

        execFileSync(command, args, { input: resolved, stdio: ['pipe', 'ignore', 'ignore'] });
      }

      return {
        version: CHANGE_VIEWER_RESULT_VERSION,
        state: 'opened',
        viewer: this.id,
        workspace: resolved,
        path: resolved,
      };
    } catch (error) {
      return unavailable(
        this.id,
        error instanceof Error ? error.message : 'clipboard is unavailable',
        'CLIPBOARD_UNAVAILABLE',
        { workspace: resolved, path: resolved },
      );
    }
  }
}

export class ChangeViewerRegistry {
  constructor({ viewers = [], explicit = null } = {}) {
    this.viewers = viewers;
    this.explicit = explicit;
  }

  open(request) {
    const preferred = this.explicit
      ? this.viewers.filter((viewer) => viewer.id === this.explicit)
      : [];

    if (this.explicit && preferred.length === 0)
      return unavailable(
        this.explicit,
        `unsupported change viewer: ${this.explicit}`,
        'VIEWER_UNSUPPORTED',
      );
    const ordered = [
      ...preferred,
      ...this.viewers.filter((viewer) => !preferred.includes(viewer) && viewer.fallback !== false),
    ];
    const unavailableResults = [];

    for (const viewer of ordered) {
      const result = viewer.open(request);

      if (result.state === 'opened') return { version: CHANGE_VIEWER_RESULT_VERSION, ...result };
      unavailableResults.push(result);
    }

    return unavailable('none', 'no change viewer is available', 'NO_VIEWER_AVAILABLE', {
      attempts: unavailableResults,
    });
  }
}

export function createChangeViewerRegistry({
  explicit = null,
  launcher = null,
  copy = null,
  platform = process.platform,
} = {}) {
  return new ChangeViewerRegistry({
    explicit,
    viewers: [
      new CommandChangeViewer({ id: 'cursor', command: 'cursor', launcher }),
      new CommandChangeViewer({ id: 'vscode', command: 'code', launcher }),
      new WorktreePathViewer({ copy, platform }),
    ],
  });
}
