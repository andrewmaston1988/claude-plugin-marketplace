import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_FOCUS_SELECTOR } from './observe.mjs';

export class ConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.field}: ${e.problem}`).join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export const BUILTIN_VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844, dpr: 3, touch: true }),
  desktop: Object.freeze({ width: 1280, height: 900 }),
});

const TOP_LEVEL_KEYS = ['baseUrl', 'viewports', 'screens', 'auth', 'outDir', 'browser', 'tv'];
const TV_KEYS = ['host', 'appid', 'sdb', 'testOrigin', 'focusSelector'];
const SCREEN_KEYS = ['url', 'steps', 'measure'];
const VIEWPORT_KEYS = ['width', 'height', 'dpr', 'touch'];
const COOKIE_KEYS = ['name', 'command', 'domain'];

const err = (field, problem, fix, example) => ({ field, problem, fix, example });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function findConfig(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, '.ui-probe.json');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validateViewport(name, value, errors) {
  const field = `viewports.${name}`;
  if (!isPlainObject(value)) {
    errors.push(err(field, 'must be an object like { "width": 390, "height": 844 }', 'make it an object with width and height', '{ "viewports": { "phone": { "width": 390, "height": 844, "dpr": 3, "touch": true } } }'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!VIEWPORT_KEYS.includes(key)) {
      errors.push(err(`${field}.${key}`, `unknown viewport key ${JSON.stringify(key)}`, `use one of ${VIEWPORT_KEYS.join(', ')}`, '{ "width": 390, "height": 844, "dpr": 3, "touch": true }'));
    }
  }
  if (!isPositiveNumber(value.width)) errors.push(err(`${field}.width`, `must be a positive finite number, got ${JSON.stringify(value.width)}`, 'set width in CSS pixels to a number greater than 0', '{ "width": 390, "height": 844 }'));
  if (!isPositiveNumber(value.height)) errors.push(err(`${field}.height`, `must be a positive finite number, got ${JSON.stringify(value.height)}`, 'set height in CSS pixels to a number greater than 0', '{ "width": 390, "height": 844 }'));
  if (value.dpr !== undefined && !isPositiveNumber(value.dpr)) errors.push(err(`${field}.dpr`, `must be a positive finite number, got ${JSON.stringify(value.dpr)}`, 'set dpr to a number greater than 0, or omit it', '{ "width": 390, "height": 844, "dpr": 3 }'));
  if (value.touch !== undefined && typeof value.touch !== 'boolean') errors.push(err(`${field}.touch`, `must be a boolean, got ${JSON.stringify(value.touch)}`, 'set touch to true or false, or omit it', '{ "width": 390, "height": 844, "touch": true }'));
}

function isHttpOrigin(v) {
  if (typeof v !== 'string') return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && (u.pathname === '' || u.pathname === '/') && !u.search && !u.hash;
}

function validateTv(value, errors) {
  const field = 'tv';
  if (!isPlainObject(value)) {
    errors.push(err(field, 'must be an object like { "host": "192.0.2.10:26101", "appid": "myapp.main" }', 'make tv an object with host and appid', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main" } }'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!TV_KEYS.includes(key)) {
      errors.push(err(`${field}.${key}`, `unknown tv key ${JSON.stringify(key)}`, `use one of ${TV_KEYS.join(', ')}`, '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main" } }'));
    }
  }
  const host = value.host;
  const hostMatch = typeof host === 'string' ? /^([^\s/:]+):(\d{1,5})$/.exec(host) : null;
  const port = hostMatch ? Number(hostMatch[2]) : NaN;
  if (!hostMatch || port < 1 || port > 65535) {
    errors.push(err('tv.host', `must be "host:port" with a port of 1-65535, got ${JSON.stringify(host)}`, 'set host to the TV address and debug port, e.g. from sdb devices', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main" } }'));
  }
  if (typeof value.appid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.appid)) {
    errors.push(err('tv.appid', `must be a Tizen app id like "myapp.main", got ${JSON.stringify(value.appid)}`, 'set appid to the id from sdb shell 0 applist', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main" } }'));
  }
  if (value.sdb !== undefined && (typeof value.sdb !== 'string' || !value.sdb.trim())) {
    errors.push(err('tv.sdb', `must be a non-empty path to the sdb executable, got ${JSON.stringify(value.sdb)}`, 'set sdb to the sdb binary path, or omit it to search PATH and the SDK layouts', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main", "sdb": "C:\\tizen\\tools\\sdb.exe" } }'));
  }
  if (value.testOrigin !== undefined && !isHttpOrigin(value.testOrigin)) {
    errors.push(err('tv.testOrigin', `must be an http(s) origin with no path, got ${JSON.stringify(value.testOrigin)}`, 'set testOrigin to the scheme, host and port only, e.g. "http://192.0.2.20:8001"', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main", "testOrigin": "http://192.0.2.20:8001" } }'));
  }
  if (value.focusSelector !== undefined && (typeof value.focusSelector !== 'string' || !value.focusSelector.trim())) {
    errors.push(err('tv.focusSelector', `must be a non-empty CSS selector, got ${JSON.stringify(value.focusSelector)}`, 'set focusSelector to the class your app moves on focus, or omit it for ".focused"', '{ "tv": { "host": "192.0.2.10:26101", "appid": "myapp.main", "focusSelector": ".focused" } }'));
  }
}

function validateScreen(name, value, errors) {
  const field = `screens.${name}`;
  if (!isPlainObject(value)) {
    errors.push(err(field, 'must be an object like { "url": "/home" }', 'make it an object with a url', '{ "screens": { "home": { "url": "/home" } } }'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!SCREEN_KEYS.includes(key)) {
      errors.push(err(`${field}.${key}`, `unknown screen key ${JSON.stringify(key)}`, `use one of ${SCREEN_KEYS.join(', ')}`, '{ "url": "/home", "steps": [], "measure": ["[data-testid=tile]"] }'));
    }
  }
  const url = value.url;
  if (typeof url !== 'string' || !url.trim()) {
    errors.push(err(`${field}.url`, 'a screen requires a non-empty url', 'set url to an absolute http(s) URL or a root-relative path starting with /', '{ "screens": { "home": { "url": "/home" } } }'));
  } else if (!(url.startsWith('/') || /^https?:\/\/\S+/.test(url))) {
    errors.push(err(`${field}.url`, `must be an absolute http(s) URL or start with /, got ${JSON.stringify(url)}`, 'use /path (resolved against baseUrl) or a full http(s) URL', '{ "url": "/home" }'));
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) {
      errors.push(err(`${field}.steps`, `must be an array of step objects, got ${JSON.stringify(value.steps)}`, 'make steps an array', '{ "steps": [{ "open": { "url": "/home" } }] }'));
    } else {
      value.steps.forEach((step, i) => {
        if (!isPlainObject(step)) errors.push(err(`${field}.steps[${i}]`, 'a step must be an object like { "open": { "url": "/" } }', 'make each step a single-key object', '{ "open": { "url": "/" } }'));
      });
    }
  }
  if (value.measure !== undefined) {
    if (!Array.isArray(value.measure)) {
      errors.push(err(`${field}.measure`, `must be an array of CSS selectors, got ${JSON.stringify(value.measure)}`, 'make measure an array of selector strings', '{ "measure": ["[data-testid=tile]"] }'));
    } else {
      value.measure.forEach((sel, i) => {
        if (typeof sel !== 'string' || !sel.trim()) errors.push(err(`${field}.measure[${i}]`, `must be a non-empty CSS selector, got ${JSON.stringify(sel)}`, 'use a non-empty selector string', '"[data-testid=tile]"'));
      });
    }
  }
}

function validateCookie(index, value, errors) {
  const field = `auth.cookies[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(err(field, 'must be an object like { "name": "session", "command": ["get-cookie"] }', 'make it an object with name and command', '{ "name": "session", "command": ["get-cookie"] }'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!COOKIE_KEYS.includes(key)) {
      errors.push(err(`${field}.${key}`, `unknown cookie key ${JSON.stringify(key)}`, `use one of ${COOKIE_KEYS.join(', ')}`, '{ "name": "session", "command": ["get-cookie"], "domain": "example.com" }'));
    }
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    errors.push(err(`${field}.name`, `must be a non-empty string, got ${JSON.stringify(value.name)}`, 'set name to the cookie name', '{ "name": "session", "command": ["get-cookie"] }'));
  }
  if (!Array.isArray(value.command) || value.command.length === 0 || !value.command.every((a) => typeof a === 'string' && a.length > 0)) {
    errors.push(err(`${field}.command`, `must be a non-empty array of non-empty strings, got ${JSON.stringify(value.command)}`, 'make command an argv array, e.g. ["get-cookie", "--token", "{TOKEN}"]', '{ "command": ["get-cookie", "--token", "{TOKEN}"] }'));
  }
  if (value.domain !== undefined && (typeof value.domain !== 'string' || !value.domain.trim())) {
    errors.push(err(`${field}.domain`, `must be a non-empty string, got ${JSON.stringify(value.domain)}`, 'set domain or omit it', '{ "domain": "example.com" }'));
  }
}

export function loadConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError([err('file', `cannot read ${configPath}: ${e.message}`, 'pass the path to an existing .ui-probe.json', 'ui-probe doctor --config .ui-probe.json')]);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError([err('(root)', `invalid JSON: ${e.message}`, 'fix the JSON syntax', '{ "baseUrl": "http://127.0.0.1:8001" }')]);
  }
  if (!isPlainObject(data)) {
    throw new ConfigError([err('(root)', 'the config must be a JSON object', 'wrap the keys in { }', '{ "baseUrl": "http://127.0.0.1:8001" }')]);
  }

  const errors = [];
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(err(key, `unknown key ${JSON.stringify(key)}`, `use one of ${TOP_LEVEL_KEYS.join(', ')}`, '{ "baseUrl": "http://127.0.0.1:8001" }'));
    }
  }

  if (typeof data.baseUrl !== 'string' || !/^https?:\/\/\S+/.test(data.baseUrl)) {
    errors.push(err('baseUrl', `must be a non-empty http(s) URL, got ${JSON.stringify(data.baseUrl)}`, 'set baseUrl to the origin the app is served from', '{ "baseUrl": "http://127.0.0.1:8001" }'));
  }

  if (data.viewports !== undefined) {
    if (!isPlainObject(data.viewports)) {
      errors.push(err('viewports', 'must be an object of named viewports', 'make viewports an object', '{ "viewports": { "phone": { "width": 390, "height": 844 } } }'));
    } else {
      for (const [name, vp] of Object.entries(data.viewports)) validateViewport(name, vp, errors);
    }
  }

  if (data.screens !== undefined) {
    if (!isPlainObject(data.screens)) {
      errors.push(err('screens', 'must be an object of named screens', 'make screens an object', '{ "screens": { "home": { "url": "/" } } }'));
    } else {
      for (const [name, screen] of Object.entries(data.screens)) validateScreen(name, screen, errors);
    }
  }

  if (data.auth !== undefined) {
    if (!isPlainObject(data.auth)) {
      errors.push(err('auth', 'must be an object with a cookies array', 'make auth an object', '{ "auth": { "cookies": [{ "name": "session", "command": ["get-cookie"] }] } }'));
    } else {
      for (const key of Object.keys(data.auth)) {
        if (key !== 'cookies') errors.push(err(`auth.${key}`, `unknown auth key ${JSON.stringify(key)}`, 'the only supported auth key is "cookies"', '{ "auth": { "cookies": [] } }'));
      }
      if (!Array.isArray(data.auth.cookies)) {
        errors.push(err('auth.cookies', `must be an array, got ${JSON.stringify(data.auth.cookies)}`, 'make cookies an array of { name, command }', '{ "auth": { "cookies": [{ "name": "session", "command": ["get-cookie"] }] } }'));
      } else {
        data.auth.cookies.forEach((cookie, i) => validateCookie(i, cookie, errors));
      }
    }
  }

  if (data.tv !== undefined) validateTv(data.tv, errors);

  if (data.outDir !== undefined && (typeof data.outDir !== 'string' || !data.outDir.trim())) {
    errors.push(err('outDir', `must be a non-empty string, got ${JSON.stringify(data.outDir)}`, 'set outDir to a directory path, or omit it for a per-run temp dir', '{ "outDir": "C:\\\\tmp\\\\ui-probe" }'));
  }
  if (data.browser !== undefined && (typeof data.browser !== 'string' || !data.browser.trim())) {
    errors.push(err('browser', `must be a non-empty string, got ${JSON.stringify(data.browser)}`, 'set browser to the browser executable path, or omit it for auto-discovery', '{ "browser": "C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe" }'));
  }

  if (errors.length) throw new ConfigError(errors);

  const config = { ...data };
  config.viewports = { ...BUILTIN_VIEWPORTS, ...(data.viewports ?? {}) };
  if (data.tv !== undefined && isPlainObject(data.tv)) {
    config.tv = { ...data.tv, focusSelector: data.tv.focusSelector ?? DEFAULT_FOCUS_SELECTOR };
  }
  if (config.outDir === undefined) {
    config.outDir = path.join(os.tmpdir(), 'ui-probe', new Date().toISOString().replace(/[:.]/g, '-'));
  }
  Object.defineProperty(config, 'configDir', { value: path.dirname(path.resolve(configPath)), enumerable: false });
  return config;
}
