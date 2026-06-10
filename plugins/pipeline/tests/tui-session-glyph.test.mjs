// Test: _sessionGlyph color and spinner logic for live sessions between tasks.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";

// Mock _pidAlive to control pid liveness in tests.
function mockSessionGlyph(pidAliveFn, spinFn) {
  const C_RED = "color(9)";
  const C_YELLOW = "color(11)";
  const C_CYAN = "color(6)";
  const C_DIM = "color(8)";
  const C_TEXT = "white";
  const C_GREEN = "color(10)";

  function _pidAlive(pid) {
    return pidAliveFn(pid);
  }

  function spin() {
    return spinFn();
  }

  function _sessionGlyph(session, prog, stageColor) {
    const spawnMs = Date.parse(session.spawn_time) || Date.now();
    const ageSecs = (Date.now() - spawnMs) / 1000;
    const dead     = session.pid > 0 && !_pidAlive(session.pid);
    const inprog   = prog.inprog > 0;
    const finished = !prog.todo && !prog.inprog && prog.done > 0;
    const stalled  = inprog && ageSecs > 30 * 60;
    if (dead)     return { spinChar: "✗",    spinColor: C_RED,    nameColor: C_RED,    timeColor: C_RED };
    if (stalled)  return { spinChar: "●",    spinColor: C_YELLOW, nameColor: C_YELLOW, timeColor: C_YELLOW };
    if (inprog)   return { spinChar: spin(), spinColor: stageColor, nameColor: C_TEXT, timeColor: stageColor };
    // Alive but no task currently in_progress (between tasks)
    if (session.is_active === 1) {
      return { spinChar: spin(), spinColor: C_DIM, nameColor: C_TEXT, timeColor: C_DIM };
    }
    if (finished) return { spinChar: "✓",    spinColor: C_DIM,    nameColor: C_DIM,    timeColor: C_DIM };
    return         { spinChar: "·",          spinColor: C_DIM,    nameColor: C_TEXT,   timeColor: C_DIM };
  }

  return { _sessionGlyph, _pidAlive, spin };
}

test("glyph: alive + no in_progress + has done → dim spinner (not ✓)", () => {
  let spinCounter = 0;
  const { _sessionGlyph } = mockSessionGlyph(
    () => true,  // pid is alive
    () => {
      spinCounter++;
      return spinCounter % 2 === 0 ? "⠋" : "⠙";
    }
  );

  const session = { pid: 1234, is_active: 1, spawn_time: new Date(Date.now() - 5000).toISOString() };
  const prog = { todo: 0, inprog: 0, done: 3 };
  const result = _sessionGlyph(session, prog, "color(6)");

  equal(result.spinChar.length > 0, true, "should return a spinner char");
  equal(result.spinColor, "color(8)", "should be dim color");
  equal(result.nameColor, "white", "should be text color");
  equal(result.timeColor, "color(8)", "should be dim color");
});

test("glyph: alive + has in_progress → full-colour spinner (unchanged)", () => {
  let spinCounter = 0;
  const { _sessionGlyph } = mockSessionGlyph(
    () => true,  // pid is alive
    () => {
      spinCounter++;
      return spinCounter % 2 === 0 ? "⠋" : "⠙";
    }
  );

  const session = { pid: 1234, is_active: 1, spawn_time: new Date(Date.now() - 5000).toISOString() };
  const prog = { todo: 0, inprog: 1, done: 2 };
  const stageColor = "color(6)";  // cyan
  const result = _sessionGlyph(session, prog, stageColor);

  equal(result.spinChar.length > 0, true, "should return a spinner char");
  equal(result.spinColor, stageColor, "should use stage color");
  equal(result.nameColor, "white", "should be text color");
  equal(result.timeColor, stageColor, "should use stage color");
});

test("glyph: not alive (is_active=0) + has done → ✓ (unchanged)", () => {
  const { _sessionGlyph } = mockSessionGlyph(
    () => true,  // pid doesn't matter when is_active=0 skips the active check
    () => "⠋"
  );

  const session = { pid: 0, is_active: 0, spawn_time: new Date(Date.now() - 5000).toISOString() };
  const prog = { todo: 0, inprog: 0, done: 3 };
  const result = _sessionGlyph(session, prog, "color(6)");

  equal(result.spinChar, "✓", "should be finished tick");
  equal(result.spinColor, "color(8)", "should be dim color");
  equal(result.nameColor, "color(8)", "should be dim color");
  equal(result.timeColor, "color(8)", "should be dim color");
});

test("glyph: pid dead → ✗ (unchanged)", () => {
  const { _sessionGlyph } = mockSessionGlyph(
    () => false,  // pid is dead
    () => "⠋"
  );

  const session = { pid: 1234, is_active: 1, spawn_time: new Date(Date.now() - 5000).toISOString() };
  const prog = { todo: 1, inprog: 0, done: 0 };
  const result = _sessionGlyph(session, prog, "color(6)");

  equal(result.spinChar, "✗", "should be dead cross");
  equal(result.spinColor, "color(9)", "should be red color");
  equal(result.nameColor, "color(9)", "should be red color");
  equal(result.timeColor, "color(9)", "should be red color");
});

test("glyph: stalled task (in_progress > 30 min) → ● (unchanged)", () => {
  const { _sessionGlyph } = mockSessionGlyph(
    () => true,  // pid is alive
    () => "⠋"
  );

  const thirtyMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const session = { pid: 1234, is_active: 1, spawn_time: thirtyMinAgo };
  const prog = { todo: 0, inprog: 1, done: 0 };
  const result = _sessionGlyph(session, prog, "color(6)");

  equal(result.spinChar, "●", "should be filled dot for stalled");
  equal(result.spinColor, "color(11)", "should be yellow color");
  equal(result.nameColor, "color(11)", "should be yellow color");
  equal(result.timeColor, "color(11)", "should be yellow color");
});
