# Windows.Media.Ocr over a PNG, emitting JSON (lines + word boxes + latency).
# Method ported from C:/code/vehicle-audio-visual-experience/tools/dhu-ocr.ps1 (2x cubic
# upscale, WinRT async waited through WindowsRuntimeSystemExtensions.AsTask).
# Windows PowerShell 5.1 only: the WinRT projections are not available in pwsh 7.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Scale = 2
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# PowerShell 5.1 defaults stdout to the OEM code page (ibm850 here), whose best-fit table
# turns U+2022 (the bullet in Blender's window title) into 0x07 — a raw BEL inside the JSON
# string, which makes the document unparseable. Emit UTF-8 instead.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# OCR returns control characters found in window titles (Blender's title carries a BEL
# before the filename); a raw 0x07 inside a JSON string makes the document unparseable.
function Clean-Text([string]$text) {
    if ($null -eq $text) { return '' }
    return ($text -replace '[\x00-\x1F]', ' ')
}

function Wait-WinRtOperation {
    param([object]$Operation, [Type]$ResultType)

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            if ($_.Name -ne 'AsTask' -or -not $_.IsGenericMethodDefinition) { return $false }
            $parameters = $_.GetParameters()
            if ($parameters.Count -ne 1) { return $false }
            $parameterType = $parameters[0].ParameterType
            return $parameterType.IsGenericType -and
                $parameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation`1'
        } |
        Select-Object -First 1

    if ($null -eq $asTaskMethod) { throw 'Could not find the generic AsTask(IAsyncOperation<T>) overload.' }
    $task = $asTaskMethod.MakeGenericMethod(@($ResultType)).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

$bitmap = $null
$stream = $null
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing file: $Path" }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $storageFileType = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $bitmapDecoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $softwareBitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
    $ocrEngineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $ocrResultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $fileAccessModeType = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $randomAccessStreamType = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
    $bitmapTransformType = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType = WindowsRuntime]

    $file = Wait-WinRtOperation -Operation $storageFileType::GetFileFromPathAsync((Resolve-Path -LiteralPath $Path).Path) -ResultType $storageFileType
    $stream = Wait-WinRtOperation -Operation $file.OpenAsync($fileAccessModeType::Read) -ResultType $randomAccessStreamType
    $decoder = Wait-WinRtOperation -Operation $bitmapDecoderType::CreateAsync($stream) -ResultType $bitmapDecoderType
    $transform = New-Object $bitmapTransformType
    $transform.ScaledWidth = $decoder.PixelWidth * $Scale
    $transform.ScaledHeight = $decoder.PixelHeight * $Scale
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
    $bitmap = Wait-WinRtOperation -Operation $decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
    ) -ResultType $softwareBitmapType
    $engine = $ocrEngineType::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'Missing OCR language pack for a user-profile language.' }

    $result = Wait-WinRtOperation -Operation $engine.RecognizeAsync($bitmap) -ResultType $ocrResultType
    $sw.Stop()

    $lines = New-Object System.Collections.Generic.List[object]
    foreach ($line in $result.Lines) {
        $words = New-Object System.Collections.Generic.List[object]
        $left = [double]::PositiveInfinity
        $top = [double]::PositiveInfinity
        $right = [double]::NegativeInfinity
        $bottom = [double]::NegativeInfinity
        foreach ($word in $line.Words) {
            $rect = $word.BoundingRect
            # Boxes come back in the upscaled space; divide by the scale to report window px.
            $words.Add([ordered]@{
                    text = Clean-Text $word.Text
                    x    = [int][Math]::Round($rect.X / $Scale)
                    y    = [int][Math]::Round($rect.Y / $Scale)
                    w    = [int][Math]::Round($rect.Width / $Scale)
                    h    = [int][Math]::Round($rect.Height / $Scale)
                })
            $left = [Math]::Min($left, $rect.X)
            $top = [Math]::Min($top, $rect.Y)
            $right = [Math]::Max($right, $rect.X + $rect.Width)
            $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
        }
        if ($words.Count -eq 0) { continue }
        $lines.Add([ordered]@{
                text  = Clean-Text $line.Text
                x     = [int][Math]::Round($left / $Scale)
                y     = [int][Math]::Round($top / $Scale)
                w     = [int][Math]::Round(($right - $left) / $Scale)
                h     = [int][Math]::Round(($bottom - $top) / $Scale)
                words = $words.ToArray()
            })
    }

    $payload = [ordered]@{
        ok        = $true
        size      = "$($decoder.PixelWidth)x$($decoder.PixelHeight)"
        scale     = $Scale
        lang      = $engine.RecognizerLanguage.LanguageTag
        lines     = $lines.ToArray()
        line_text = ($lines | ForEach-Object { $_.text }) -join "`n"
        ocr_ms    = [int]$sw.ElapsedMilliseconds
    }
    # ConvertTo-Json leaves raw control characters in place; scrub the serialised line so
    # one BEL in a window title cannot break the whole document.
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $safe = -join ($json.ToCharArray() | ForEach-Object {
            if ([int]$_ -lt 32) { ' ' } else { $_ }
        })
    Write-Output $safe
}
catch {
    $sw.Stop()
    Write-Output ((@{ ok = $false; error = $_.Exception.Message; ocr_ms = [int]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress))
    exit 1
}
finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
