# =============================================================================
#  Asset build pipeline
#  Reads the raw sheets from SpriteSheetCreater and produces, per character,
#  one trimmed + downscaled atlas (.png) plus a manifest (.json) for the game.
#
#  Per animation the opaque area is cropped tight, so the atlas carries far
#  less empty space than the raw sheets. Every animation records the anchor
#  (the point that sits on the character's feet), which is what lets the base
#  sheet and the *_extra sheet line up even though their frames differ in size.
#
#  This is stage 1 of 2. It writes uncompressed PNG atlases into .build/atlas;
#  tools/pack.mjs then encodes them to WebP in assets/characters, which is what
#  the game ships. Run both with:  npm run assets
#
#  Run stage 1 alone:  powershell -ExecutionPolicy Bypass -File tools\build-assets.ps1
#  ASCII only (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
# =============================================================================
param(
  [string]$Src = "C:\Claude_projects\SpriteSheetCreater\output_sprite",
  [string]$Out = "$PSScriptRoot\..\.build\atlas"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content "$PSScriptRoot\SpriteTool.cs" -Raw -Encoding UTF8) -ReferencedAssemblies System.Drawing

$THR = 8      # alpha above this counts as opaque
$FOOTBAND = 30  # source px above the sole, used by the 'foot' anchor metric
$GROUNDRATIO = 0.12  # a row counts as "the character" at 12% of the busiest row

# -- character configuration ---------------------------------------------------
# targetHeight : on-screen height in game units for the reference pose
# anchorMetric : 'body' = alpha-weighted median X of the whole silhouette. The
#                median shrugs off thin outliers (an extended sword, a trailing
#                cape) and landed on the stance centre for all three characters.
#                'foot' = median X of a band just above the soles. Kept for
#                characters whose upper body leans far off their feet; it fails
#                on wide stances where one boot sits higher than the other.
# dx / dy      : manual nudge in source px, applied after the automatic anchor
$CONFIG = @(
  @{
    id = 'swordsman'; targetHeight = 215; anchorMetric = 'body'
    sheets = @(
      @{ file = 'swordsman';        ref = 'idle';   dx = 0; dy = 0 },
      @{ file = 'swordsman_extra';  ref = 'land';   dx = 0; dy = 0 },
      @{ file = 'swordsman_crouch'; ref = 'crouch'; dx = 0; dy = 0 }
    )
  },
  @{
    id = 'berserker'; targetHeight = 225; anchorMetric = 'body'
    sheets = @(
      @{ file = 'berserker';        ref = 'idle';   dx = 0; dy = 0 },
      @{ file = 'berserker_crouch'; ref = 'crouch'; dx = 0; dy = 0 }
    )
  },
  @{
    id = 'mage'; targetHeight = 212; anchorMetric = 'body'
    sheets = @(
      @{ file = 'mage';        ref = 'idle';   dx = 0; dy = 0 },
      @{ file = 'mage_extra';  ref = 'guard';  dx = 0; dy = 0 },
      @{ file = 'mage_crouch'; ref = 'crouch'; dx = 0; dy = 0 }
    )
  },
  @{
    # jkgirl_extra holds 'point' (the skill cue) and 'photo' (the laser).
    id = 'schoolgirl'; targetHeight = 200; anchorMetric = 'body'
    sheets = @(
      @{ file = 'jkgirl';        ref = 'idle';   dx = 0; dy = 0 },
      @{ file = 'jkgirl_extra';  ref = 'point';  dx = 0; dy = 0 },
      @{ file = 'jkgirl_crouch'; ref = 'crouch'; dx = 0; dy = 0 }
    )
  },
  @{
    # Not a playable character: the boyfriend the schoolgirl's skill summons.
    # Built as its own atlas so the renderer can draw him like any other sprite.
    id = 'boyfriend'; targetHeight = 215; anchorMetric = 'body'
    sheets = @(
      @{ file = 'jkboy'; ref = 'run'; dx = 0; dy = 0 }
    )
  }
)

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force $Out | Out-Null }
$Out = (Resolve-Path $Out).Path

function Get-FrameBBox($sheet, $rc) {
  # bbox in frame-local coordinates, or $null when the frame is empty
  $b = $sheet.BBox($rc.x, $rc.y, $rc.w, $rc.h, $THR)
  if ($b[2] -eq 0) { return $null }
  return @{ x = $b[0] - $rc.x; y = $b[1] - $rc.y; w = $b[2]; h = $b[3] }
}

foreach ($cfg in $CONFIG) {
  Write-Host ""
  Write-Host "--- $($cfg.id) ---"

  $loaded = @()
  foreach ($s in $cfg.sheets) {
    $meta = Get-Content "$Src\$($s.file).json" -Raw | ConvertFrom-Json
    $loaded += @{
      cfg   = $s
      meta  = $meta
      sheet = (New-Object KakutoTools.Sheet("$Src\$($s.file).png"))
    }
  }

  # 1. per sheet: ground line and horizontal anchor, measured on its reference pose
  foreach ($L in $loaded) {
    $ref = $L.meta.animations.($L.cfg.ref)
    if (-not $ref) { throw "$($L.cfg.file): reference animation '$($L.cfg.ref)' not found" }
    $bottoms = @(); $anchors = @(); $heights = @()
    foreach ($rc in $ref.frameRects) {
      $b = Get-FrameBBox $L.sheet $rc
      if (-not $b) { continue }
      # soles, not the lowest pixel: a blade tip or cape can hang below the boots
      $sole = $L.sheet.GroundRow($rc.x, $rc.y, $rc.w, $rc.h, $THR, $GROUNDRATIO) - $rc.y
      $bottoms += $sole
      $heights += ($sole - $b.y)
      switch ($cfg.anchorMetric) {
        'foot' { $anchors += ($L.sheet.MedianX($rc.x, ($rc.y + $sole - $FOOTBAND), $rc.w, $FOOTBAND, $THR) - $rc.x) }
        'body' { $anchors += ($L.sheet.MedianX($rc.x, $rc.y, $rc.w, $rc.h, $THR) - $rc.x) }
        default { throw "unknown anchorMetric '$($cfg.anchorMetric)'" }
      }
    }
    $L.groundY = (($bottoms | Measure-Object -Maximum).Maximum) + $L.cfg.dy
    $L.anchorX = (($anchors | Measure-Object -Average).Average) + $L.cfg.dx
    $L.refHeight = ($heights | Measure-Object -Maximum).Maximum
    Write-Host ("  {0,-18} ground={1,4}  anchorX={2,7}  refH={3,4}" -f `
      $L.cfg.file, $L.groundY, [math]::Round($L.anchorX, 1), $L.refHeight)
  }

  # 2. one scale for the whole character, derived from the first sheet's reference pose
  $scale = $cfg.targetHeight / $loaded[0].refHeight
  $pad = [math]::Ceiling(2.0 / $scale)   # keeps bilinear sampling off the crop edge
  Write-Host ("  scale={0}  pad={1}px" -f [math]::Round($scale, 4), $pad)

  # 3. collect every animation, cropped tight
  $rows = @()
  foreach ($L in $loaded) {
    foreach ($p in $L.meta.animations.PSObject.Properties) {
      $name = $p.Name
      if ($rows | Where-Object { $_.name -eq $name }) {
        throw "$($cfg.id): animation name '$name' appears in more than one sheet"
      }
      $anim = $p.Value
      $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = -1; $maxY = -1
      foreach ($rc in $anim.frameRects) {
        $b = Get-FrameBBox $L.sheet $rc
        if (-not $b) { continue }
        if ($b.x -lt $minX) { $minX = $b.x }
        if ($b.y -lt $minY) { $minY = $b.y }
        if (($b.x + $b.w) -gt $maxX) { $maxX = $b.x + $b.w }
        if (($b.y + $b.h) -gt $maxY) { $maxY = $b.y + $b.h }
      }
      $fw = $anim.frameRects[0].w; $fh = $anim.frameRects[0].h
      $ux = [math]::Max(0, $minX - $pad)
      $uy = [math]::Max(0, $minY - $pad)
      $uw = [math]::Min($fw, $maxX + $pad) - $ux
      $uh = [math]::Min($fh, $maxY + $pad) - $uy

      $rows += @{
        name   = $name
        L      = $L
        anim   = $anim
        ux     = $ux; uy = $uy; uw = $uw; uh = $uh
        cw     = [int][math]::Ceiling($uw * $scale)
        ch     = [int][math]::Ceiling($uh * $scale)
        ax     = [math]::Round(($L.anchorX - $ux) * $scale, 2)
        ay     = [math]::Round(($L.groundY - $uy) * $scale, 2)
        frames = $anim.frameRects.Count
      }
    }
  }

  # 4. lay the rows out, one animation per row
  $atlasW = 0; $atlasH = 0
  foreach ($r in $rows) {
    $r.x = 0
    $r.y = $atlasH
    $rowW = $r.cw * $r.frames
    if ($rowW -gt $atlasW) { $atlasW = $rowW }
    $atlasH += $r.ch
  }

  # 5. draw
  $canvas = New-Object KakutoTools.Canvas($atlasW, $atlasH)
  foreach ($r in $rows) {
    for ($i = 0; $i -lt $r.frames; $i++) {
      $rc = $r.anim.frameRects[$i]
      $canvas.Blit($r.L.sheet,
        ($rc.x + $r.ux), ($rc.y + $r.uy), $r.uw, $r.uh,
        ($r.x + $i * $r.cw), $r.y, $r.cw, $r.ch)
    }
  }
  $pngPath = Join-Path $Out "$($cfg.id).png"
  $canvas.Save($pngPath)
  $canvas.Dispose()

  # 6. manifest
  $anims = [ordered]@{}
  foreach ($r in $rows) {
    $anims[$r.name] = [ordered]@{
      x = $r.x; y = $r.y; cw = $r.cw; ch = $r.ch
      frames = $r.frames; ax = $r.ax; ay = $r.ay
      src = $r.L.cfg.file
    }
  }
  $manifest = [ordered]@{
    id         = $cfg.id
    image      = "$($cfg.id).png"
    atlasWidth = $atlasW
    atlasHeight = $atlasH
    sourceFps  = $loaded[0].meta.fps
    scale      = [math]::Round($scale, 5)
    height     = $cfg.targetHeight
    animations = $anims
  }
  $jsonPath = Join-Path $Out "$($cfg.id).json"
  # Set-Content -Encoding UTF8 emits a BOM on PS 5.1, which JSON.parse rejects.
  [System.IO.File]::WriteAllText($jsonPath, ($manifest | ConvertTo-Json -Depth 6),
    (New-Object System.Text.UTF8Encoding($false)))

  foreach ($L in $loaded) { $L.sheet.Dispose() }
  $kb = [math]::Round((Get-Item $pngPath).Length / 1KB)
  Write-Host ("  atlas {0}x{1}  {2} anims  {3} KB" -f $atlasW, $atlasH, $rows.Count, $kb)
}

Write-Host ""
Write-Host "Output -> $Out"
Get-ChildItem $Out | ForEach-Object { "  {0,-22} {1,8} KB" -f $_.Name, [math]::Round($_.Length / 1KB) }

