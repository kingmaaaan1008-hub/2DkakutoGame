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
  [string]$Out = "$PSScriptRoot\..\.build\atlas",
  # Texels stored per world unit. 1 means the atlas holds exactly the on-screen
  # size at zoom 1 -- but the game zooms in on desktop (about 1.4x on a 720p
  # window, up to ~3.4x on a retina laptop), so at 1 the sprites are magnified
  # at draw time and look soft. Raising this stores more detail; the manifest
  # carries the factor and the renderer divides it back out, so world units,
  # anchors and hit boxes are unaffected. Above ~2 there is nothing left to
  # gain: the raw sheets only hold about 2x the on-screen height.
  #
  # 2 is what ships. Do not lower it without rebuilding, or the atlases and the
  # manifests they are read with will disagree about how big a texel is.
  [double]$Supersample = 2,
  # Pixels per atlas page. A character's animations are split across as many
  # pages as this allows, because iOS Safari refuses to decode a single image
  # much past 16.7 Mpx (4096x4096) -- at Supersample 2 one page per character
  # reached 35 Mpx and the game died on iPhone while working everywhere else.
  # 8 Mpx leaves room under that ceiling, and smaller pages also mean Safari
  # only has to hold the ones actually being drawn.
  [double]$MaxPagePixels = 8e6
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
# skip         : animations in that sheet to leave out of the atlas, for poses
#                that were redrawn on a later sheet and are no longer used
# stabilizeX   : animations to re-centre horizontally, frame by frame. Normally one
#                anchor per sheet is enough, because the character stays put in the
#                source clip. Clips where she travels (a flight move filmed moving
#                across the frame) drift instead, and the drift shows up in game as
#                the character jittering left and right while the loop plays. For
#                these, each frame is shifted so its own silhouette lands on the
#                sheet anchor, which pins the body in place and leaves only the
#                intended motion (wings, limbs).
# stabilizeY   : the same, vertically. A flight clip filmed while the character
#                climbs rises frame by frame, so a looping animation bounces back
#                down every time it wraps.
#                The target differs from stabilizeX on purpose. Horizontally every
#                animation should share one stance, so frames are pulled onto the
#                sheet anchor. Vertically the right height is per animation (a
#                hovering pose belongs above a standing one), so frames are pulled
#                onto *that animation's own mean* instead: the drift goes away and
#                the height it was drawn at stays.
$CONFIG = @(
  @{
    id = 'swordsman'; targetHeight = 215; anchorMetric = 'body'
    sheets = @(
      @{ file = 'swordsman';         ref = 'idle';    dx = 0; dy = 0 },
      @{ file = 'swordsman_extra';   ref = 'land';    dx = 0; dy = 0 },
      @{ file = 'swordsman_crouch';  ref = 'crouch';  dx = 0; dy = 0 },
      @{ file = 'swordsman_grabbed'; ref = 'grabbed'; dx = 0; dy = 0 }
    )
  },
  @{
    id = 'berserker'; targetHeight = 225; anchorMetric = 'body'
    sheets = @(
      @{ file = 'berserker';         ref = 'idle';    dx = 0; dy = 0 },
      @{ file = 'berserker_crouch';  ref = 'crouch';  dx = 0; dy = 0 },
      @{ file = 'berserker_grabbed'; ref = 'grabbed'; dx = 0; dy = 0 }
    )
  },
  @{
    id = 'mage'; targetHeight = 212; anchorMetric = 'body'
    sheets = @(
      @{ file = 'mage';         ref = 'idle';    dx = 0; dy = 0 },
      @{ file = 'mage_extra';   ref = 'guard';   dx = 0; dy = 0 },
      @{ file = 'mage_crouch';  ref = 'crouch';  dx = 0; dy = 0 },
      @{ file = 'mage_grabbed'; ref = 'grabbed'; dx = 0; dy = 0 }
    )
  },
  @{
    # jkgirl_extra holds 'point' (the skill cue) and 'photo' (the laser).
    # jkgirl_v2 holds the redrawn 'run2' / 'death2', which is what the game uses
    # for dashing and dying, so the base sheet's 'run' / 'death' are skipped.
    id = 'schoolgirl'; targetHeight = 200; anchorMetric = 'body'
    sheets = @(
      @{ file = 'jkgirl';         ref = 'idle';    dx = 0; dy = 0; skip = @('run', 'death') },
      @{ file = 'jkgirl_extra';   ref = 'point';   dx = 0; dy = 0 },
      @{ file = 'jkgirl_crouch';  ref = 'crouch';  dx = 0; dy = 0 },
      @{ file = 'jkgirl_v2';      ref = 'run2';    dx = 0; dy = 0 },
      @{ file = 'jkgirl_grabbed'; ref = 'grabbed'; dx = 0; dy = 0 }
    )
  },
  @{
    # The succubus. 'grabbed' rides on the base sheet (she can be grabbed in a
    # mirror match), so only the attack and crouch sheets are separate.
    id = 'succubus'; targetHeight = 205; anchorMetric = 'body'
    sheets = @(
      # 'move' is the dashing flight loop; she crosses the frame while it is filmed.
      @{ file = 'succubus';        ref = 'idle';   dx = 0; dy = 0; stabilizeX = @('move') },
      @{ file = 'succubus_attack'; ref = 'claw1';  dx = 0; dy = 0 },
      @{ file = 'succubus_crouch'; ref = 'crouch'; dx = 0; dy = 0 }
    )
  },
  @{
    # The cavalier. Everything except 'grabbed' rides on one sheet, including the
    # five attack rows the moves are cut from. 'move' is her thruster flight loop,
    # filmed while she crosses the frame, so it is stabilised like the succubus's.
    id = 'cavalier'; targetHeight = 208; anchorMetric = 'body'
    sheets = @(
      # 'move' はスラスターで滑る飛行ループ。撮っている間にキャラが画面を横切り、
      # なおかつ上へ昇っていくので、横も縦も止める必要がある
      # （縦を止めないと、ループが頭に戻るたびに 29 単位ぴょこんと落ちる）。
      @{ file = 'cavalier';         ref = 'idle';    dx = 0; dy = 0
         stabilizeX = @('move'); stabilizeY = @('move') },
      @{ file = 'cavalier_grabbed'; ref = 'grabbed'; dx = 0; dy = 0 }
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
  $scale = ($cfg.targetHeight * $Supersample) / $loaded[0].refHeight
  $pad = [math]::Ceiling(2.0 / $scale)   # keeps bilinear sampling off the crop edge
  Write-Host ("  scale={0}  pad={1}px" -f [math]::Round($scale, 4), $pad)

  # 3. collect every animation, cropped tight
  $rows = @()
  foreach ($L in $loaded) {
    foreach ($p in $L.meta.animations.PSObject.Properties) {
      $name = $p.Name
      if ($L.cfg.skip -and ($L.cfg.skip -contains $name)) {
        Write-Host "  skip $($L.cfg.file)/$name"
        continue
      }
      if ($rows | Where-Object { $_.name -eq $name }) {
        throw "$($cfg.id): animation name '$name' appears in more than one sheet"
      }
      $anim = $p.Value
      $fw = $anim.frameRects[0].w; $fh = $anim.frameRects[0].h

      # per-frame horizontal correction, in source px. Zero unless stabilised.
      $shift = @()
      foreach ($rc in $anim.frameRects) {
        if ($L.cfg.stabilizeX -and ($L.cfg.stabilizeX -contains $name)) {
          $mx = $L.sheet.MedianX($rc.x, $rc.y, $rc.w, $rc.h, $THR) - $rc.x
          $shift += [int][math]::Round($mx - $L.anchorX)
        } else {
          $shift += 0
        }
      }

      # per-frame vertical correction. Pulled onto this animation's own mean,
      # so the height it was drawn at survives and only the drift is removed.
      $shiftY = @()
      if ($L.cfg.stabilizeY -and ($L.cfg.stabilizeY -contains $name)) {
        $mys = @()
        foreach ($rc in $anim.frameRects) {
          $mys += ($L.sheet.MedianY($rc.x, $rc.y, $rc.w, $rc.h, $THR) - $rc.y)
        }
        $midY = ($mys | Measure-Object -Average).Average
        foreach ($my in $mys) { $shiftY += [int][math]::Round($my - $midY) }
        Write-Host ("  stabilizeY {0,-10} drift={1}px" -f $name,
          (($mys | Measure-Object -Maximum).Maximum - ($mys | Measure-Object -Minimum).Minimum))
      } else {
        foreach ($rc in $anim.frameRects) { $shiftY += 0 }
      }

      # union of the frame boxes, measured after the correction
      $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = -1; $maxY = -1
      for ($i = 0; $i -lt $anim.frameRects.Count; $i++) {
        $b = Get-FrameBBox $L.sheet $anim.frameRects[$i]
        if (-not $b) { continue }
        $bx = $b.x - $shift[$i]
        $by = $b.y - $shiftY[$i]
        if ($bx -lt $minX) { $minX = $bx }
        if ($by -lt $minY) { $minY = $by }
        if (($bx + $b.w) -gt $maxX) { $maxX = $bx + $b.w }
        if (($by + $b.h) -gt $maxY) { $maxY = $by + $b.h }
      }

      # The crop is read at ux + shift, so it has to stay inside the frame for
      # every frame; otherwise a shifted read would pull in the neighbouring one.
      $sMin = ($shift | Measure-Object -Minimum).Minimum
      $sMax = ($shift | Measure-Object -Maximum).Maximum
      $sMinY = ($shiftY | Measure-Object -Minimum).Minimum
      $sMaxY = ($shiftY | Measure-Object -Maximum).Maximum
      $loX = [math]::Max(0, -$sMin)
      $hiX = $fw - [math]::Max(0, $sMax)
      $loY = [math]::Max(0, -$sMinY)
      $hiY = $fh - [math]::Max(0, $sMaxY)
      $ux = [math]::Max($loX, $minX - $pad)
      $uy = [math]::Max($loY, $minY - $pad)
      $uw = [math]::Min($hiX, $maxX + $pad) - $ux
      $uh = [math]::Min($hiY, $maxY + $pad) - $uy
      if ($uw -le 0) { throw "$($cfg.id)/${name}: stabilizeX の補正が大きすぎてコマに収まらない" }
      if ($uh -le 0) { throw "$($cfg.id)/${name}: stabilizeY の補正が大きすぎてコマに収まらない" }

      $rows += @{
        name   = $name
        L      = $L
        anim   = $anim
        shift  = $shift
        shiftY = $shiftY
        ux     = $ux; uy = $uy; uw = $uw; uh = $uh
        cw     = [int][math]::Ceiling($uw * $scale)
        ch     = [int][math]::Ceiling($uh * $scale)
        ax     = [math]::Round(($L.anchorX - $ux) * $scale, 2)
        ay     = [math]::Round(($L.groundY - $uy) * $scale, 2)
        frames = $anim.frameRects.Count
      }
    }
  }

  # 4. lay the rows out, one animation per row, filling one page at a time
  #
  # A page is only as wide as its widest row, so rows are grouped widest first:
  # that keeps the narrow animations off the wide pages instead of padding every
  # one of them out to the widest row in the character. Name breaks ties so the
  # layout is the same on every run.
  $ordered = $rows | Sort-Object -Property @{ Expression = { $_.cw * $_.frames }; Descending = $true },
                                           @{ Expression = { $_.name }; Descending = $false }
  $pages = @()
  $cur = @{ rows = @(); w = 0; h = 0 }
  foreach ($r in $ordered) {
    $rowW = $r.cw * $r.frames
    $w = [math]::Max($cur.w, $rowW)
    $h = $cur.h + $r.ch
    # A row never gets split, so a page that holds only one row is allowed to
    # go over the budget (the widest row here is ~2.7 Mpx, well inside it).
    if ($cur.rows.Count -gt 0 -and ($w * $h) -gt $MaxPagePixels) {
      $pages += , $cur
      $cur = @{ rows = @(); w = 0; h = 0 }
      $w = $rowW; $h = $r.ch
    }
    $r.page = $pages.Count
    $r.x = 0
    $r.y = $cur.h
    $cur.rows += $r
    $cur.w = $w
    $cur.h = $h
  }
  if ($cur.rows.Count -gt 0) { $pages += , $cur }

  # 5. draw, one image per page
  $pageFiles = @()
  $pageSizes = @()
  for ($pi = 0; $pi -lt $pages.Count; $pi++) {
    $p = $pages[$pi]
    $canvas = New-Object KakutoTools.Canvas($p.w, $p.h)
    foreach ($r in $p.rows) {
      for ($i = 0; $i -lt $r.frames; $i++) {
        $rc = $r.anim.frameRects[$i]
        $canvas.Blit($r.L.sheet,
          ($rc.x + $r.ux + $r.shift[$i]), ($rc.y + $r.uy + $r.shiftY[$i]), $r.uw, $r.uh,
          ($r.x + $i * $r.cw), $r.y, $r.cw, $r.ch)
      }
    }
    $pageName = "$($cfg.id)-$pi.png"
    $canvas.Save((Join-Path $Out $pageName))
    $canvas.Dispose()
    $pageFiles += $pageName
    $pageSizes += [ordered]@{ w = $p.w; h = $p.h }
    Write-Host ("  page {0}  {1}x{2}  {3} Mpx  {4} anims" -f `
      $pi, $p.w, $p.h, [math]::Round($p.w * $p.h / 1e6, 1), $p.rows.Count)
  }

  # 6. manifest
  $anims = [ordered]@{}
  foreach ($r in $rows) {
    $anims[$r.name] = [ordered]@{
      # which of the images this animation's row lives on
      page = $r.page
      x = $r.x; y = $r.y; cw = $r.cw; ch = $r.ch
      frames = $r.frames; ax = $r.ax; ay = $r.ay
      src = $r.L.cfg.file
    }
  }
  $manifest = [ordered]@{
    id         = $cfg.id
    # One entry per page, in page order. animations[].page indexes into this.
    images     = @($pageFiles)
    pages      = @($pageSizes)
    sourceFps  = $loaded[0].meta.fps
    scale      = [math]::Round($scale, 5)
    height     = $cfg.targetHeight
    # cw/ch/ax/ay はテクセル単位。ワールド単位に戻すにはこれで割る。
    texelsPerUnit = $Supersample
    animations = $anims
  }
  $jsonPath = Join-Path $Out "$($cfg.id).json"
  # Set-Content -Encoding UTF8 emits a BOM on PS 5.1, which JSON.parse rejects.
  [System.IO.File]::WriteAllText($jsonPath, ($manifest | ConvertTo-Json -Depth 6),
    (New-Object System.Text.UTF8Encoding($false)))

  foreach ($L in $loaded) { $L.sheet.Dispose() }
  $kb = 0
  foreach ($f in $pageFiles) { $kb += (Get-Item (Join-Path $Out $f)).Length / 1KB }
  Write-Host ("  {0} pages  {1} anims  {2} KB" -f $pages.Count, $rows.Count, [math]::Round($kb))
}

Write-Host ""
Write-Host "Output -> $Out"
Get-ChildItem $Out | ForEach-Object { "  {0,-22} {1,8} KB" -f $_.Name, [math]::Round($_.Length / 1KB) }

