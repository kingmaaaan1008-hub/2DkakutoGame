# Survey script: measures where the opaque pixels sit inside each animation row.
# ASCII only (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content "$PSScriptRoot\SpriteTool.cs" -Raw -Encoding UTF8) -ReferencedAssemblies System.Drawing

$SRC = "C:\Claude_projects\SpriteSheetCreater\output_sprite"
$THR = 8
$sheets = @('swordsman','swordsman_extra','berserker','mage','mage_extra')

foreach ($name in $sheets) {
  $meta = Get-Content "$SRC\$name.json" -Raw | ConvertFrom-Json
  $sheet = New-Object KakutoTools.Sheet("$SRC\$name.png")
  $fw = $meta.frameWidth; $fh = $meta.frameHeight
  Write-Host ""
  Write-Host "=== $name  frame ${fw}x${fh} ==="
  Write-Host ("{0,-10} {1,5} {2,5} {3,5} {4,5} | {5,6} {6,7} {7,7}" -f 'anim','x','y','w','h','bottom','bboxCX','centrX')
  foreach ($p in $meta.animations.PSObject.Properties) {
    $anim = $p.Value
    $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = -1; $maxY = -1
    $cxs = @()
    foreach ($rc in $anim.frameRects) {
      $b = $sheet.BBox($rc.x, $rc.y, $rc.w, $rc.h, $THR)
      if ($b[2] -eq 0) { continue }
      $lx = $b[0] - $rc.x; $ly = $b[1] - $rc.y
      if ($lx -lt $minX) { $minX = $lx }
      if ($ly -lt $minY) { $minY = $ly }
      if (($lx + $b[2]) -gt $maxX) { $maxX = $lx + $b[2] }
      if (($ly + $b[3]) -gt $maxY) { $maxY = $ly + $b[3] }
      $cxs += ($sheet.CentroidX($rc.x, $rc.y, $rc.w, $rc.h, $THR) - $rc.x)
    }
    $centro = [math]::Round(($cxs | Measure-Object -Average).Average, 1)
    Write-Host ("{0,-10} {1,5} {2,5} {3,5} {4,5} | {5,6} {6,7} {7,7}" -f `
      $p.Name, $minX, $minY, ($maxX-$minX), ($maxY-$minY), $maxY, [math]::Round(($minX+$maxX)/2,1), $centro)
  }
  $sheet.Dispose()
}
