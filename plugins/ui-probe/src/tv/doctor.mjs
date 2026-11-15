// The doctor's TV checks, split from the CLI's branches: a web-only machine never loads this.

import { appIds, findSdb, listedDevices, sdb } from './sdb.mjs';

/**
 * The TV's three checks. Skipped entirely when the config has no tv block, so a web-only machine
 * or CI never needs the Tizen SDK.
 */
export function doctorTv(config, { out, err, _findSdb = findSdb, _sdb = null } = {}) {
  const callSdb = _sdb ?? ((args) => sdb(args, { config }));
  const exe = _findSdb(config);
  if (!exe) {
    err('FAIL tv.sdb: sdb not found — set tv.sdb in .ui-probe.json, put sdb on PATH, or install the Tizen SDK');
    return false;
  }
  out(`ok   tv.sdb: ${exe}`);

  let devices;
  try {
    devices = callSdb(['devices']);
  } catch (error) {
    err(`FAIL tv.device: ${error.message}`);
    return false;
  }
  if (!listedDevices(devices.stdout).includes(config.tv.host)) {
    // attach() connects a host sdb has not seen yet; doctor does the same, then reads again.
    try { callSdb(['connect', config.tv.host]); } catch { /* the check below reports it */ }
    try {
      devices = callSdb(['devices']);
    } catch (error) {
      err(`FAIL tv.device: ${error.message}`);
      return false;
    }
    if (!listedDevices(devices.stdout).includes(config.tv.host)) {
      err(`FAIL tv.device: ${config.tv.host} is not listed by sdb — developer mode may have expired (it lasts two weeks), or the TV is off`);
      return false;
    }
  }
  out(`ok   tv.device: ${config.tv.host}`);

  let list;
  try {
    list = callSdb(['shell', '0', 'applist']);
  } catch (error) {
    err(`FAIL tv.appid: ${error.message}`);
    return false;
  }
  const ids = appIds(list.stdout);
  if (!ids.includes(config.tv.appid)) {
    const installed = ids.length ? ids.join(', ') : '(none)';
    err(`FAIL tv.appid: ${config.tv.appid} is not installed — sdb applist has: ${installed}`);
    return false;
  }
  out(`ok   tv.appid: ${config.tv.appid}`);
  return true;
}
