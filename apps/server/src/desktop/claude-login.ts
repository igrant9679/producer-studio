// "Sign in to Claude": open a visible terminal running `claude auth login` (the CLI drives the browser OAuth flow).
// The binary path always comes from detection/Settings, never from the request.
import { spawn } from 'node:child_process'
import os from 'node:os'
import { cliEnv } from '../ai/cli/detect'
import { HttpError } from '../http'

export function openSignInTerminal(bin: string) {
  if (/["%&|<>^\r\n]/.test(bin)) throw new HttpError(400, 'invalid', 'The Claude CLI path contains characters that can’t be used in a terminal command')
  const env = cliEnv()
  if (process.platform === 'win32') {
    // cmd /c start "<title>" cmd /k ""<exe>" auth login"   (/k strips the outer pair of quotes)
    const child = spawn('cmd.exe', ['/d', '/c', `start "Claude sign-in" cmd.exe /k ""${bin}" auth login"`], {
      env,
      cwd: os.homedir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    })
    child.on('error', () => undefined)
    child.unref()
    return
  }
  const quoted = `'${bin.replace(/'/g, `'\\''`)}' auth login`
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `tell application "Terminal" to do script "${quoted.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']]
      : ['x-terminal-emulator', ['-e', `sh -c "${quoted.replace(/"/g, '\\"')}; exec sh"`]]
  const child = spawn(cmd as string, args as string[], { env, cwd: os.homedir(), detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}
