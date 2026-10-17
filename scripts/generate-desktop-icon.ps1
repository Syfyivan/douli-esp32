# Rasterize the project's existing Android vector. No external artwork.
Add-Type -AssemblyName System.Drawing
$taskRoot = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $taskRoot 'desktop\assets'
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.ScaleTransform((256.0 / 48), (256.0 / 48))
$green = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#4a6a58'))
$cream = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#f6f5f0'))
$graphics.FillEllipse($green, 2, 2, 44, 44)
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddBezier(24,12,16,12,12,19,15,27)
$shape.AddBezier(15,27,18,35,31,35,34,25)
$shape.AddBezier(34,25,36,18,31,12,24,12)
$shape.CloseFigure()
$shape.StartFigure()
$shape.AddBezier(22,9,25,4,32,6,33,8)
$shape.AddBezier(33,8,29,12,24,13,22,9)
$shape.CloseFigure()
$graphics.FillPath($cream, $shape)
$pngPath = Join-Path $assetDirectory 'icon.png'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$png = [System.IO.File]::ReadAllBytes($pngPath)
$stream = [System.IO.File]::Create((Join-Path $assetDirectory 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png)
$writer.Dispose(); $graphics.Dispose(); $shape.Dispose(); $green.Dispose(); $cream.Dispose(); $bitmap.Dispose()
Write-Output 'Desktop PNG and ICO generated from the existing vector.'
