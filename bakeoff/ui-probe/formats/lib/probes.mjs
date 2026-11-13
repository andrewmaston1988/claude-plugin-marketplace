// Non-browser probes shared by the IR runner and the CLI the Playwright format calls.
// One implementation, so all three formats measure the same fixture the same way.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UIA_SCRIPT = path.join(HERE, '..', 'fixtures', 'uia-read.ps1');

export async function httpJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* body stays null; caller reports it */ }
  return { status: res.status, body, text };
}

export function tcpBanner(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buf = '';
    const done = (fn, arg) => {
      socket.destroy();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error(`no banner within ${timeoutMs} ms`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      const line = buf.split(/\r?\n/)[0];
      if (buf.includes('\n') || buf.length > 512) {
        clearTimeout(timer);
        done(resolve, line.trim());
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); done(reject, err); });
  });
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// UIA read. winapp is the installed UIA client and sees the WinForms controls as
// Edit/Value elements; the spawned PowerShell UIA client in this environment only
// surfaces MSAA proxy Panes, so it is the fallback, not the primary.
export function uiaText(window, control, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('winapp', ['ui', 'get-value', control, '--json', '-a', window], {
      shell: process.platform === 'win32', windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`winapp timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const parsed = JSON.parse(stripAnsi(out).trim());
          return resolve(parsed.text ?? parsed.value ?? null);
        } catch {
          return resolve(stripAnsi(out).trim());
        }
      }
      return fallbackPowerShell(window, control, timeoutMs).then(resolve, () =>
        reject(new Error(`winapp exited ${code}: ${stripAnsi(err || out).trim()}`)));
    });
  });
}

function fallbackPowerShell(window, control, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', UIA_SCRIPT,
      '-WindowTitle', window, '-ControlName', control, '-TimeoutMs', String(Math.min(timeoutMs, 10000))],
    { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stripAnsi(out).trim());
        if (parsed.found) return resolve(parsed.text);
        return reject(new Error(`control ${control} not found in window ${window}`));
      } catch {
        return reject(new Error(`UIA read failed: ${stripAnsi(out).trim() || 'no output'}`));
      }
    });
  });
}
