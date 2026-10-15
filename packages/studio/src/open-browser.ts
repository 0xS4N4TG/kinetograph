import { spawn } from 'node:child_process';

/** The command that opens `url` in the default browser on `platform`. */
export function openerCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  return { command: 'xdg-open', args: [url] };
}

/** Opens `url` in the default browser. A machine without one (a server over SSH) is not an error. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { command, args } = openerCommand(platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No opener: the URL has been printed.
  }
}
