# Pure decision function for the tray's 2s poll (D4c). Dot-sourced by tray.ps1,
# so it must not set process-wide preferences or otherwise touch the caller's
# scope beyond defining Get-TrayAction and Get-TrayDisabled.
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
#   DashboardEnabled    dashboard.enabled as read from ~/.swarm/config.json on THIS
#                        tick. $null when the file or the key could not be read.
#   DisabledSeed        the spawn-time off state, used only when DashboardEnabled is
#                        $null. A disabled read outranks every other input: a missing
#                        record is then the NORMAL state, not `serve stop`, and
#                        restarting is not a thing the operator asked for.
#
# Output: 'none' | 'restart' | 'crashed' | 'exit' | 'disabled'.
function Get-TrayDisabled {
  param(
    [Nullable[bool]]$DashboardEnabled,
    [bool]$DisabledSeed = $false
  )
  # An unreadable config is not an answer, so the seed stands. That keeps a config
  # file mid-rewrite from talking the tray out of its only way back on.
  if ($null -eq $DashboardEnabled) { return $DisabledSeed }
  return (-not $DashboardEnabled)
}

function Get-TrayAction {
  param(
    [Nullable[int]]$RecordPid,
    [bool]$Alive,
    [int]$Streak,
    [bool]$SamePid,
    [array]$RestartTimestamps = @(),
    [long]$Now = 0,
    [Nullable[bool]]$DashboardEnabled,
    [bool]$DisabledSeed = $false
  )

  # First: with the dashboard off, the absent-streak exit below would take the tray
  # down ten seconds after it appeared — and the tray is the only surface left that
  # can turn the dashboard back on.
  if (Get-TrayDisabled -DashboardEnabled $DashboardEnabled -DisabledSeed $DisabledSeed) { return "disabled" }

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
