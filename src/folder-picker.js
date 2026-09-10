import { execFile } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);

          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function outputOf(result) {
  if (typeof result === 'string') return result.trim() || null;

  return typeof result?.stdout === 'string' ? result.stdout.trim() || null : null;
}

function detailOf(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';

  return stderr || error?.message || 'unknown error';
}

function isMacCancellation(error) {
  return error?.code === 1 && /(?:user canceled|-128)/i.test(detailOf(error));
}

function isLinuxCancellation(error) {
  return error?.code === 1 && !String(error?.stderr ?? '').trim();
}

async function pickOnLinux(runCommand) {
  for (const [command, args] of [
    ['zenity', ['--file-selection', '--directory', '--title=Choose a Git repository']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', 'Choose a Git repository']],
  ]) {
    try {
      return outputOf(await runCommand(command, args));
    } catch (error) {
      if (isLinuxCancellation(error)) return null;
      if (error?.code === 'ENOENT') continue;
      throw new Error(`folder picker failed: ${detailOf(error)}`, { cause: error });
    }
  }

  throw new Error('folder picker is unavailable: install zenity or kdialog');
}

export async function pickFolder({ platform = process.platform, runCommand = run } = {}) {
  if (platform === 'darwin') {
    try {
      return outputOf(
        await runCommand('osascript', [
          '-e',
          'POSIX path of (choose folder with prompt "Choose a Git repository")',
        ]),
      );
    } catch (error) {
      if (isMacCancellation(error)) return null;
      throw new Error(`folder picker failed: ${detailOf(error)}`, { cause: error });
    }
  }

  if (platform === 'win32') {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose a Git repository'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }";

    try {
      return outputOf(
        await runCommand('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-Command',
          script,
        ]),
      );
    } catch (error) {
      throw new Error(`folder picker failed: ${detailOf(error)}`, { cause: error });
    }
  }

  if (platform === 'linux') return pickOnLinux(runCommand);

  throw new Error(`folder picker is unsupported on ${platform}`);
}
