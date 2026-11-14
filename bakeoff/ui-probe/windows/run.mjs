// RQ4 runner: one contender per invocation, identical tasks/repeats/timings for all.
//
//   node run.mjs --contender ps-warm
//   node run.mjs --contender pywinauto-call --actions find,tree
//   node run.mjs --report
//
// Every run launches its own fixtures and kills only the PIDs it started.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeContender, CONTENDERS, HERE } from './adapters.mjs';
import {
  REPEATS, WARMUPS, FIXTURES, launchFixture, launchNotepad, killFixture,
  invoke, summarize, makeTmpDir, cleanTmp, countLogLines, msSince,
} from './harness.mjs';

const RAW_DIR = path.join(HERE, '..', 'results', 'raw');

const LATENCY_ACTIONS = ['find', 'tree', 'tree_cached', 'get', 'click', 'list'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') out.report = true;
    else if (a === '--probes') out.probes = true;
    else if (a === '--contender') out.contender = argv[++i];
    else if (a.startsWith('--contender=')) out.contender = a.split('=')[1];
    else if (a === '--actions') out.actions = argv[++i].split(',');
    else if (a.startsWith('--actions=')) out.actions = a.split('=')[1].split(',');
  }
  return out;
}

function cmdFor(op, fixture) {
  const base = { op, title: fixture.title };
  if (op === 'get') base.name = fixture.textName;
  if (op === 'click') base.name = fixture.saveName;
  if (op === 'list') base.name = fixture.listName;
  return base;
}

function verify(op, reply, fixture, logDelta) {
  switch (op) {
    case 'find':
      return Boolean(reply.ok) && (reply.name === fixture.title || reply.pid === fixture.pid);
    case 'tree':
    case 'tree_uncached':
      return Boolean(reply.ok) && Number(reply.count) > 0;
    case 'tree_cached':
      return reply.unsupported ? null : Boolean(reply.ok) && Number(reply.count) > 0;
    case 'get':
      return Boolean(reply.ok) && String(reply.value) === fixture.textValue;
    case 'click':
      return Boolean(reply.ok) && logDelta > 0;
    case 'list':
      return Boolean(reply.ok) && (reply.items ?? []).length === 5;
    default:
      return null;
  }
}

async function oneSample(adapter, cmd, fixture, logFile) {
  const before = logFile ? countLogLines(logFile) : 0;
  const reply = await invoke(adapter, cmd);
  const after = logFile ? countLogLines(logFile) : 0;
  return { reply, verified: verify(cmd.op, reply, fixture, after - before) };
}

async function measureRow(contenderId, op, fixture, logFile) {
  const cmd = cmdFor(op, fixture);
  const row = {
    fixture: fixture.kind, action: op, contender: contenderId,
    cold: null, warm: null, unsupported: false, notes: null,
  };

  // Static capability gaps are recorded, not measured as slow failures.
  if (op === 'tree_cached' && (contenderId === 'winapp' || contenderId.startsWith('pywinauto'))) {
    row.unsupported = true;
    row.notes = contenderId === 'winapp'
      ? 'winapp ui has no CacheRequest surface'
      : 'pywinauto has no CacheRequest API';
    return row;
  }

  for (const phase of ['cold', 'warm']) {
    const samples = [];
    const bytes = [];
    let okCount = 0;
    let verifiedCount = 0;
    let verifiedKnown = 0;
    const errors = [];
    if (phase === 'cold') {
      for (let i = 0; i < REPEATS; i += 1) {
        const adapter = makeContender(contenderId);
        const t0 = performance.now();
        await adapter.start();
        const { reply, verified } = await oneSample(adapter, cmd, fixture, logFile);
        samples.push(msSince(t0));
        bytes.push(reply.__bytes ?? 0);
        if (reply.ok) okCount += 1;
        else errors.push(reply.error ?? 'unknown error');
        if (verified !== null) {
          verifiedKnown += 1;
          if (verified) verifiedCount += 1;
        }
        await adapter.stop();
      }
    } else {
      const adapter = makeContender(contenderId);
      await adapter.start();
      for (let i = 0; i < WARMUPS; i += 1) await invoke(adapter, cmd);
      for (let i = 0; i < REPEATS; i += 1) {
        const { reply, verified } = await oneSample(adapter, cmd, fixture, logFile);
        samples.push(reply.__wall_ms ?? 0);
        bytes.push(reply.__bytes ?? 0);
        if (reply.ok) okCount += 1;
        else errors.push(reply.error ?? 'unknown error');
        if (verified !== null) {
          verifiedKnown += 1;
          if (verified) verifiedCount += 1;
        }
      }
      await adapter.stop();
    }
    row[phase] = {
      ...summarize(samples),
      ok: okCount,
      n_expected: REPEATS,
      verified: verifiedKnown ? verifiedCount : null,
      verified_known: verifiedKnown,
      bytes_p50: summarize(bytes).p50,
      errors: [...new Set(errors)].slice(0, 3),
    };
  }
  return row;
}

async function exposureRow(contenderId, op, fixture) {
  const adapter = makeContender(contenderId);
  await adapter.start();
  const cmd = cmdFor(op, fixture);
  const reply = await invoke(adapter, cmd);
  await adapter.stop();
  return {
    fixture: fixture.kind,
    action: op,
    ok: Boolean(reply.ok),
    count: reply.count ?? null,
    value: reply.value ?? null,
    contains_reference: reply.value ? String(reply.value).includes(fixture.textValue ?? 'fixture-value-42') : null,
    bytes: reply.__bytes ?? 0,
    error: reply.ok ? null : reply.error,
  };
}

async function eventProbe(contenderId, fixture) {
  const supported = contenderId.startsWith('ps-warm') || contenderId.startsWith('flaui');
  if (!supported) {
    return { supported: false, note: 'no UIA event subscription in this contender' };
  }
  const adapter = makeContender(contenderId);
  await adapter.start();
  const result = { supported: true, structure: null, property: null };
  try {
    const sub = await invoke(adapter, { op: 'subscribe', title: fixture.title });
    if (!sub.ok) throw new Error(sub.error ?? 'subscribe failed');

    const tClick0 = Date.now();
    const click = await invoke(adapter, { op: 'click', title: fixture.title, name: 'RemoveTargetButton' });
    const clickDone = Date.now();
    let structure = null;
    for (let i = 0; i < 20 && !structure; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const ev = await invoke(adapter, { op: 'events' });
      const hits = (ev.events ?? []).filter((e) => e.includes('structure'));
      if (hits.length) structure = { count: hits.length, first_ms: Date.now() - clickDone, raw: hits.slice(0, 2) };
    }
    result.structure = structure ?? {
      count: 0, first_ms: null,
      note: `click ok=${click.ok}; no structure event within 2s`,
    };

    const tSet0 = Date.now();
    const set = await invoke(adapter, { op: 'set', title: fixture.title, name: fixture.textName, value: 'fixture-value-42b' });
    const setDone = Date.now();
    let property = null;
    for (let i = 0; i < 20 && !property; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const ev = await invoke(adapter, { op: 'events' });
      const hits = (ev.events ?? []).filter((e) => e.includes('property'));
      if (hits.length) property = { count: hits.length, first_ms: Date.now() - setDone, raw: hits.slice(0, 2) };
    }
    result.property = property ?? {
      count: 0, first_ms: null,
      note: `set ok=${set.ok} (${Date.now() - tSet0}ms); no property event within 2s`,
    };
    await invoke(adapter, { op: 'unsubscribe', title: fixture.title });
  } finally {
    await adapter.stop();
  }
  return result;
}

async function failureProbes(contenderId, fixture, logFile) {
  const results = {};
  {
    const adapter = makeContender(contenderId);
    await adapter.start();
    const click = await invoke(adapter, { op: 'click', title: fixture.title, name: 'RemoveTargetButton' });
    await new Promise((r) => setTimeout(r, 400));
    const gone = await invoke(adapter, { op: 'get', title: fixture.title, name: fixture.checkName });
    results.element_gone = {
      setup_ok: Boolean(click.ok),
      ok: Boolean(gone.ok),
      error: gone.error ?? null,
      ms: gone.__wall_ms ?? null,
    };
    await adapter.stop();
  }
  return results;
}

async function closedWindowProbe(contenderId, fixture) {
  const adapter = makeContender(contenderId);
  await adapter.start();
  const before = await invoke(adapter, { op: 'get', title: fixture.title, name: fixture.textName });
  killFixture(fixture);
  await new Promise((r) => setTimeout(r, 500));
  const after = await invoke(adapter, { op: 'get', title: fixture.title, name: fixture.textName });
  const tree = await invoke(adapter, { op: 'tree', title: fixture.title });
  await adapter.stop();
  return {
    before_ok: Boolean(before.ok),
    after_ok: Boolean(after.ok),
    after_error: after.error ?? null,
    after_ms: after.__wall_ms ?? null,
    tree_ok: Boolean(tree.ok),
    tree_error: tree.error ?? null,
    tree_ms: tree.__wall_ms ?? null,
  };
}

async function runContender(contenderId, actionsFilter, probesOnly) {
  const tmp = makeTmpDir('windows');
  const logFile = path.join(tmp, 'fixture-clicks.log');
  fs.writeFileSync(logFile, '');
  const fixtures = {};
  const started = [];
  const out = {
    contender: makeContender(contenderId).label,
    contender_id: contenderId,
    mode: makeContender(contenderId).mode,
    notes: makeContender(contenderId).notes,
    repeats: REPEATS,
    warmups: WARMUPS,
    latency: [],
    exposure: [],
    events: null,
    failures: {},
    fixture: null,
    started_at: new Date().toISOString(),
  };
  try {
    for (const kind of ['WinForms', 'Wpf', 'OwnerDrawn']) {
      fixtures[kind] = await launchFixture(kind, tmp, logFile);
      started.push(fixtures[kind]);
    }
    fixtures.Notepad = await launchNotepad(tmp);
    started.push(fixtures.Notepad);
    out.fixture = {
      winforms_pid: fixtures.WinForms.pid,
      wpf_pid: fixtures.Wpf.pid,
      owner_pid: fixtures.OwnerDrawn.pid,
      notepad_pid: fixtures.Notepad.pid,
      notepad_title: fixtures.Notepad.title,
      titles: {
        WinForms: fixtures.WinForms.title,
        Wpf: fixtures.Wpf.title,
        OwnerDrawn: fixtures.OwnerDrawn.title,
        Notepad: fixtures.Notepad.title,
      },
    };

    const actions = (actionsFilter ?? LATENCY_ACTIONS).filter((a) => LATENCY_ACTIONS.includes(a));
    for (const op of actions) {
      if (probesOnly) continue;
      process.stderr.write(`  ${contenderId}: ${op} cold/warm\n`);
      out.latency.push(await measureRow(contenderId, op, fixtures.WinForms, logFile));
    }

    if (!actionsFilter) {
      for (const [kind, ops] of [['Wpf', ['find', 'tree', 'get', 'list']], ['OwnerDrawn', ['find', 'tree', 'get']], ['Notepad', ['find', 'tree', 'get']]]) {
        for (const op of ops) {
          out.exposure.push(await exposureRow(contenderId, op, fixtures[kind]));
        }
      }
      out.events = await eventProbe(contenderId, fixtures.WinForms);
      out.failures = await failureProbes(contenderId, fixtures.WinForms, logFile);
      out.failures.window_closed = await closedWindowProbe(contenderId, fixtures.WinForms);
    }
  } finally {
    for (const f of started) killFixture(f);
    cleanTmp(tmp);
  }
  out.finished_at = new Date().toISOString();
  return out;
}

function mergeRaw() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const merged = [];
  for (const file of fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'))) {
    merged.push(JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), 'utf8')));
  }
  merged.sort((a, b) => CONTENDERS.indexOf(a.contender_id) - CONTENDERS.indexOf(b.contender_id));
  fs.writeFileSync(path.join(HERE, '..', 'results', 'windows-raw.json'), JSON.stringify(merged, null, 2));
  return merged;
}

function printReport(merged) {
  const lines = [];
  for (const c of merged) {
    lines.push(`\n## ${c.contender} (${c.contender_id}, ${c.mode})\n`);
    lines.push('| action | cold p50 | cold p95 | warm p50 | warm p95 | ok | verified | bytes p50 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of c.latency) {
      if (r.unsupported) {
        lines.push(`| ${r.action} | unsupported | | | | | | ${r.notes ?? ''} |`);
        continue;
      }
      const cell = (p) => (p ? `${p.p50} / ${p.p95}` : '');
      lines.push(`| ${r.action} | ${r.cold ? `${r.cold.p50}` : ''} | ${r.cold?.p95 ?? ''} | ${r.warm?.p50 ?? ''} | ${r.warm?.p95 ?? ''} | ${r.cold?.ok}/${r.cold?.n_expected} | ${r.warm?.verified ?? '-'}/${r.warm?.verified_known ?? '-'} | ${r.warm?.bytes_p50 ?? ''} |`);
    }
    lines.push('\nExposure: ' + JSON.stringify(c.exposure));
    lines.push('\nEvents: ' + JSON.stringify(c.events));
    lines.push('\nFailures: ' + JSON.stringify(c.failures));
  }
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.report) {
  const merged = mergeRaw();
  console.log(printReport(merged));
} else {
  if (!args.contender) {
    console.error(`usage: node run.mjs --contender <${CONTENDERS.join('|')}> [--actions a,b]`);
    process.exit(2);
  }
  const result = await runContender(args.contender, args.actions, args.probes);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `${args.contender}.json`);
  let rows = [result];
  if ((args.actions || args.probes) && fs.existsSync(file)) {
    // Split runs: an --actions pass keeps the other actions' rows; a --probes pass keeps
    // every latency row and only refreshes the exposure/event/failure probes.
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (args.probes) {
      result.latency = prior.latency ?? [];
    } else {
      const keep = (prior.latency ?? []).filter((r) => !(args.actions ?? []).includes(r.action));
      result.latency = [...keep, ...result.latency];
      result.exposure = prior.exposure ?? [];
      result.events = prior.events ?? null;
      result.failures = prior.failures ?? {};
    }
  }
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`wrote ${file}`);
}
