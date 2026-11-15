// The local bearer token shared by Crew and the jira-board HTTP server. It is NOT a Jira credential: it only proves a request
// comes from someone who can read a file in the user's own config folder.
//
// Where: %APPDATA%\deadline-seance-crew\local-token on Windows, $XDG_CONFIG_HOME (or ~/.config)/deadline-seance-crew/local-token
// elsewhere. DSC_JIRA_BOARD_TOKEN_FILE overrides the path (used by the tests). Never inside the repo.
// Created once, with user-only permissions: mode 0600 in a 0700 folder; on Windows, inherited ACLs are removed and only the
// current user is granted access (icacls).

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;

export function tokenPath(env = process.env, platform = process.platform) {
  if (env.DSC_JIRA_BOARD_TOKEN_FILE && env.DSC_JIRA_BOARD_TOKEN_FILE.trim() !== '') return env.DSC_JIRA_BOARD_TOKEN_FILE.trim();
  const base =
    platform === 'win32'
      ? env.APPDATA && env.APPDATA !== '' ? env.APPDATA : join(homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'deadline-seance-crew', 'local-token');
}

function restrictOnWindows(path) {
  const user = process.env.USERNAME;
  if (!user) throw new Error('USERNAME is not set');
  const domain = process.env.USERDOMAIN;
  const who = domain ? `${domain}\\${user}` : user;
  // /inheritance:r drops the ACEs inherited from %APPDATA%; /grant:r leaves exactly one: full control for this user.
  execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${who}:F`], { stdio: 'ignore', windowsHide: true });
}

/**
 * Reads the token, creating it on first use. Returns { token, path, created }. Throws if the file exists but does not hold a
 * valid token (it is never overwritten), or if the Windows permissions cannot be set on a new file.
 */
export function loadOrCreateToken({ env = process.env, platform = process.platform } = {}) {
  const path = tokenPath(env, platform);
  let existing;
  try {
    existing = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read the local token file (${error.code}).`);
  }
  if (existing !== undefined) {
    if (!TOKEN_RE.test(existing)) throw new Error('The local token file does not hold a valid token. Delete it to make a new one.');
    return { token: existing, path, created: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
  try {
    if (platform === 'win32') restrictOnWindows(path);
    else chmodSync(path, 0o600);
  } catch {
    // A token file that may be readable by others is not kept.
    rmSync(path, { force: true });
    throw new Error('Could not make the local token file private; it was removed.');
  }
  return { token, path, created: true };
}
