// What a live block says beside its clock: the tool line, behind `Not read yet`
// while the session has not taken a routed message.
const NOT_READ = "Not read yet";

// Per peer, not per window: a read racing a window's close would otherwise be
// lost with the window.
const unreadCounts = new Map();  // peer_id → count

export function addUnread(peerId) {
  unreadCounts.set(peerId, (unreadCounts.get(peerId) ?? 0) + 1);
}

export function takeUnread(peerId) {
  const left = (unreadCounts.get(peerId) ?? 0) - 1;
  if (left > 0) unreadCounts.set(peerId, left);
  else unreadCounts.delete(peerId);
}

export function clearUnread(peerId) { unreadCounts.delete(peerId); }

export function resetUnread() { unreadCounts.clear(); }

export function hasUnread(peerId) { return unreadCounts.has(peerId); }

export function statusLine(window) {
  const unread = hasUnread(window.peerId) ? NOT_READ : "";
  return [unread, window.lastStatus].filter(Boolean).join(" · ");
}

export function showStatus(window) {
  window.heartbeat?.setStatus?.(statusLine(window));
}
