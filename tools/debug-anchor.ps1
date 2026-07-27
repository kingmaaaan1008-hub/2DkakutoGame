# Draws one raw frame with the detected sole line, foot band and anchor candidates.
param(
  [string]$Sheet = 'berserker',
  [string]$Anim = 'idle',
  [int]$Frame = 3,
  [string]$Out = "$PSScriptRoot\..\.debug"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content "$PSScriptRoot\SpriteTool.cs" -Raw -Encoding UTF8) -ReferencedAssemblies System.Drawing

$SRC = "C:\Claude_projects\SpriteSheetCreater\output_sprite"
$THR = 8; $BAND = 30
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force $Out | Out-Null }
$Out = (Resolve-Path $Out).Path

$meta = Get-Content "$SRC\$Sheet.json" -Raw | ConvertFrom-Json
$sh = New-Object KakutoTools.Sheet("$SRC\$Sheet.png")
$rc = $meta.animations.$Anim.frameRects[$Frame]

$b = $sh.BBox($rc.x, $rc.y, $rc.w, $rc.h, $THR)
$sole = $sh.GroundRow($rc.x, $rc.y, $rc.w, $rc.h, $THR, 0.12)
$med = $sh.MedianX($rc.x, ($sole - $BAND), $rc.w, $BAND, $THR)
$cen = $sh.CentroidX($rc.x, ($sole - $BAND), $rc.w, $BAND, $THR)
$bodyMed = $sh.MedianX($rc.x, $rc.y, $rc.w, $rc.h, $THR)

Write-Host "bbox local  x=$($b[0]-$rc.x) y=$($b[1]-$rc.y) w=$($b[2]) h=$($b[3])"
Write-Host "sole local  y=$($sole-$rc.y)   bboxBottom=$($b[1]-$rc.y+$b[3])"
Write-Host "footMedian  x=$([math]::Round($med-$rc.x,1))   footCentroid=$([math]::Round($cen-$rc.x,1))   bodyMedian=$([math]::Round($bodyMed-$rc.x,1))"

$S = 0.6
$W = [int]($rc.w * $S); $H = [int]($rc.h * $S)
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 25, 27, 34))
$g.InterpolationMode = 'HighQualityBicubic'
$img = [System.Drawing.Image]::FromFile("$SRC\$Sheet.png")
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $W, $H)), $rc.x, $rc.y, $rc.w, $rc.h, [System.Drawing.GraphicsUnit]::Pixel)

# foot band
$bandBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 255, 220, 80))
$g.FillRectangle($bandBrush, 0, [int](($sole - $BAND - $rc.y) * $S), $W, [int]($BAND * $S))
# lines
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 90, 230, 140), 2)), 0, [int](($sole - $rc.y) * $S), $W, [int](($sole - $rc.y) * $S))
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 80, 80), 2)), [int](($med - $rc.x) * $S), 0, [int](($med - $rc.x) * $S), $H)
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 90, 160, 255), 2)), [int](($cen - $rc.x) * $S), 0, [int](($cen - $rc.x) * $S), $H)
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 160, 40), 2)), [int](($bodyMed - $rc.x) * $S), 0, [int](($bodyMed - $rc.x) * $S), $H)
$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 200, 200, 200), 1)),
  [int](($b[0] - $rc.x) * $S), [int](($b[1] - $rc.y) * $S), [int]($b[2] * $S), [int]($b[3] * $S))
$g.DrawString("red=footMedian  blue=footCentroid  orange=bodyMedian  green=sole",
  (New-Object System.Drawing.Font("Consolas", 9)), [System.Drawing.Brushes]::White, 4, 4)

$g.Dispose(); $img.Dispose(); $sh.Dispose()
$bmp.Save("$Out\anchor_${Sheet}_${Anim}_$Frame.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote anchor_${Sheet}_${Anim}_$Frame.png"
