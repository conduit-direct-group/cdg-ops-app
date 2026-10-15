# Makes the app icons and the top-bar logo from the CDG logo in brand\.
# Run: & 'C:\CDG\tools\make-icons.ps1'
#
# Source: brand\cdg-logo-horizontal-white.png — orange CDG circle on the left, white "CONDUIT DIRECT GROUP"
# on the right, see-through background. The circle fills the full height of the image, so the circle is the
# square at the left edge (height x height).
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'brand\cdg-logo-horizontal-white.png'
$iconDir = Join-Path $root 'web\icons'
$black = [System.Drawing.Color]::FromArgb(17, 17, 17)

$logo = [System.Drawing.Image]::FromFile($source)
$circle = New-Object System.Drawing.Rectangle 0, 0, $logo.Height, $logo.Height

# The lines inside the circle are see-through in the source file. A white disc behind the circle
# (a hair smaller, so no white shows at the edge) brings back the white lines of the real logo.
function Add-WhiteDisc($g, [single]$x, [single]$y, [single]$d) {
  $inset = $d * 0.012
  $g.FillEllipse([System.Drawing.Brushes]::White, $x + $inset, $y + $inset, $d - 2 * $inset, $d - 2 * $inset)
}

function New-Graphics($bmp) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  return $g
}

# App icon: the CDG circle centered on black. The circle uses 76% of the width, which keeps it inside the
# "safe zone" when Android crops icons to a circle or rounded square.
function New-Icon([int]$size, [string]$file, [double]$fill = 0.76) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = New-Graphics $bmp
  $g.Clear($black)
  $d = [int][Math]::Round($size * $fill)
  $offset = [int](($size - $d) / 2)
  Add-WhiteDisc $g $offset $offset $d
  $g.DrawImage($logo, (New-Object System.Drawing.Rectangle $offset, $offset, $d, $d), $circle, [System.Drawing.GraphicsUnit]::Pixel)
  $bmp.Save((Join-Path $iconDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Made icons\$file ($size x $size)"
}

# Top-bar logo: the whole horizontal logo, shrunk to 120 px tall (sharp on high-resolution phone screens
# when shown at 40 px), see-through background kept.
function New-Banner([int]$height, [string]$file) {
  $width = [int][Math]::Round($logo.Width * $height / $logo.Height)
  $bmp = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = New-Graphics $bmp
  $g.Clear([System.Drawing.Color]::Transparent)
  Add-WhiteDisc $g 0 0 $height
  $g.DrawImage($logo, 0, 0, $width, $height)
  $bmp.Save((Join-Path $iconDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Made icons\$file ($width x $height)"
}

New-Icon 512 'icon-512.png'
New-Icon 192 'icon-192.png'
New-Icon 180 'apple-touch-icon.png' 0.84
New-Icon 32 'favicon-32.png' 0.94
New-Banner 120 'logo-banner.png'
$logo.Dispose()
