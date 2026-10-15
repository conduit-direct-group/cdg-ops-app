# Draws the placeholder app icons (orange "CDG" on black) into web\icons.
# Replace with the real logo when available. Run: & 'C:\CDG\tools\make-icons.ps1'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\web\icons'
$orange = [System.Drawing.Color]::FromArgb(243, 112, 33)
$black = [System.Drawing.Color]::FromArgb(17, 17, 17)

function New-Icon([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear($black)

  # Everything stays inside the middle 60% so phones can crop the icon to a circle safely.
  $font = New-Object System.Drawing.Font('Arial', [single]($size * 0.25), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $textBox = New-Object System.Drawing.RectangleF 0, ([single]($size * -0.04)), $size, $size
  $g.DrawString('CDG', $font, (New-Object System.Drawing.SolidBrush $orange), $textBox, $format)

  # Orange bar under the letters, like the app's top bar.
  $barWidth = [int]($size * 0.46)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $orange), [int](($size - $barWidth) / 2), [int]($size * 0.64), $barWidth, [int]([Math]::Max(2, $size * 0.035)))

  $bmp.Save((Join-Path $outDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Made $file ($size x $size)"
}

New-Icon 512 'icon-512.png'
New-Icon 192 'icon-192.png'
New-Icon 180 'apple-touch-icon.png'
New-Icon 32 'favicon-32.png'
