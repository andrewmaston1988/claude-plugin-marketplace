# PrintWindow capture of one top-level window, for the RQ5 OCR lane.
# Windows PowerShell 5.1 only (System.Drawing + Add-Type C#).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$OutFile
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('UiProbeCapture' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class UiProbeCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);

    // PW_RENDERFULLCONTENT: needed for windows whose client area is composited rather
    // than painted straight to the window DC.
    public const uint PW_RENDERFULLCONTENT = 0x00000002;

    public static string Capture(IntPtr hwnd, string path, out int width, out int height)
    {
        width = 0; height = 0;
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return "window-not-found";
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return "getwindowrect-failed: " + Marshal.GetLastWin32Error();
        width = r.Right - r.Left;
        height = r.Bottom - r.Top;
        if (width <= 0 || height <= 0) return "empty-window-rect";
        using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok) return "printwindow-failed";
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return null;
    }
}
'@
}

$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if ($null -eq $proc) {
    Write-Output '{"ok":false,"error":"window not found"}'
    exit 1
}

$hwnd = $proc.MainWindowHandle
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$width = 0
$height = 0
$err = [UiProbeCapture]::Capture($hwnd, $OutFile, [ref]$width, [ref]$height)
$sw.Stop()

$result = [ordered]@{
    ok          = ($null -eq $err)
    error       = $err
    pid         = $proc.Id
    hwnd        = [int64]$hwnd
    width       = $width
    height      = $height
    png         = $OutFile
    capture_ms  = [int]$sw.ElapsedMilliseconds
    bytes       = $(if (Test-Path -LiteralPath $OutFile) { (Get-Item -LiteralPath $OutFile).Length } else { 0 })
}
Write-Output (($result | ConvertTo-Json -Compress))
