# Renders every animation of a built atlas anchored to a common ground line,
# so cross-sheet alignment can be checked by eye.
param([string]$Out = "$PSScriptRoot\..\.debug")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ASSETS = "$PSScriptRoot\..\.build\atlas"
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force $Out | Out-Null }
$Out = (Resolve-Path $Out).Path

$CELLW = 210; $CELLH = 290; $BASE = 250; $CX = 105
$PICKS = @(0, 3, 7)

foreach ($id in @('swordsman', 'berserker', 'mage')) {
  $man = Get-Content "$ASSETS\$id.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  # The atlas is split across pages; each animation says which one it is on.
  $atlasPages = @($man.images | ForEach-Object { [System.Drawing.Image]::FromFile("$ASSETS\$_") })
  $names = @($man.animations.PSObject.Properties.Name)

  $W = 120 + $CELLW * $PICKS.Count
  $H = $CELLH * $names.Count
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 28, 30, 38))
  $g.InterpolationMode = 'HighQualityBicubic'
  $font = New-Object System.Drawing.Font("Consolas", 10)
  $groundPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 90, 220, 140))
  $axisPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 240, 120, 120))
  $cellPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 60, 66, 82))

  $row = 0
  foreach ($name in $names) {
    $a = $man.animations.$name
    $top = $row * $CELLH
    $g.DrawString("$name`n$($a.src)", $font, [System.Drawing.Brushes]::White, 4, $top + 8)
    for ($k = 0; $k -lt $PICKS.Count; $k++) {
      $i = $PICKS[$k]
      $cellX = 120 + $k * $CELLW
      $g.DrawRectangle($cellPen, $cellX, $top, $CELLW, $CELLH)
      # anchor lands on (CX, BASE) inside the cell
      $dx = $cellX + $CX - $a.ax
      $dy = $top + $BASE - $a.ay
      $g.DrawImage($atlasPages[$a.page],
        (New-Object System.Drawing.Rectangle([int]$dx, [int]$dy, [int]$a.cw, [int]$a.ch)),
        ($a.x + $i * $a.cw), $a.y, $a.cw, $a.ch, [System.Drawing.GraphicsUnit]::Pixel)
      $g.DrawLine($axisPen, ($cellX + $CX), $top, ($cellX + $CX), ($top + $CELLH))
      $g.DrawLine($groundPen, $cellX, ($top + $BASE), ($cellX + $CELLW), ($top + $BASE))
    }
    $row++
  }
  $g.Dispose()
  foreach ($p in $atlasPages) { $p.Dispose() }
  $bmp.Save("$Out\verify_$id.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote verify_$id.png"
}
