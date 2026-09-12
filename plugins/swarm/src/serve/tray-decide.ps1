# Pure decision function for the tray's 2s poll (D4c). Dot-sourced by tray.ps1,
# so it must not set process-wide preferences or otherwise touch the caller's
# scope beyond defining Get-TrayAction.
#
# Inputs are the state AT THE MOMENT OF DECISION, always from a fresh re-read:
#   RecordPid           pid in the freshly re-read pid record, or $null if the
#                        record is absent (a deliberate `serve stop`).
#   Alive               is that pid alive right now.
#   Streak              consecutive prior polls this same condition has held —
#                        record-present-and-dead, or record-absent — tracked by
#                        the caller (two separate counters; whichever applies is
#                        passed here).
#   SamePid             does RecordPid match the pid the streak was counted
#                        against. False on a handover: a replacement's own
#                        `retake()` can rewrite the record with a different pid
#                        between one poll and the next, and that self-heal must
#                        never be read as "still dead".
#   RestartTimestamps   epoch-ms of restarts this tray has already issued.
#   Now                 epoch-ms "now", for the 10-minute restart window.
#
# Output: 'none' | 'restart' | 'crashed' | 'exit'.
function Get-TrayAction {
  param(
    [Nullable[int]]$RecordPid,
    [bool]$Alive,
    [int]$Streak,
    [bool]$SamePid,
    [array]$RestartTimestamps = @(),
    [long]$Now = 0
  )

  if ($null -eq $RecordPid) {
    # No record: today's "exit after 5 dead polls" — a deliberate `serve stop`.
    if ($Streak -ge 5) { return "exit" }
    return "none"
  }

  # Re-read gate: alive now, or the pid moved since the streak started, both
  # mean the daemon (or its own handover retake) already healed itself.
  if ($Alive) { return "none" }
  if (-not $SamePid) { return "none" }
  if ($Streak -lt 5) { return "none" }

  $windowMs = 10 * 60 * 1000
  $recent = @($RestartTimestamps | Where-Object { ($Now - $_) -lt $windowMs })
  if ($recent.Count -ge 3) { return "crashed" }
  return "restart"
}
