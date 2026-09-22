# Reports whether the process that started it owns a VISIBLE console window, so a
# test can measure the thing notify's spawn options are actually about instead of
# asserting on the options object. Writes "hwnd=<n> visible=<bool>" and exits.
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type -Name W -Namespace SwarmProbe -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
'@
$hwnd = [SwarmProbe.W]::GetConsoleWindow()
$visible = if ($hwnd -ne [System.IntPtr]::Zero) { [SwarmProbe.W]::IsWindowVisible($hwnd) } else { $false }
Set-Content -Path $Out -Value "hwnd=$hwnd visible=$visible" -Encoding utf8
