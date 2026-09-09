# Books Curator - stamp a new build version
#
# Rewrites the service worker's cache name and app.js's APP_VERSION to the same
# UTC stamp. Bumping the cache name is what makes installed phones fetch the new
# code, and doing it by hand was a step easy to forget (a Vinyl Curator lesson).
#
# Run directly, or let .git/hooks/pre-commit run it for you:
#   powershell -ExecutionPolicy Bypass -File .\bump-version.ps1
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI unless
# there is a BOM, so a stray em dash becomes mojibake and breaks the parse.

$ErrorActionPreference = 'Stop'

# Seconds matter: two commits in the same minute must not produce the same cache
# name, or the second one never reaches an installed phone.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-Stamped {
  param([string]$File, [string]$Pattern, [string]$Replacement)

  $path = Join-Path $PSScriptRoot $File
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

  # Test the match separately from the result: an unchanged file could mean the
  # line is missing, or merely that it already carries this stamp.
  if (-not [regex]::IsMatch($text, $Pattern)) {
    throw "$File - version line not found (pattern: $Pattern). Fix the pattern or the file."
  }
  $new = [regex]::Replace($text, $Pattern, $Replacement)
  # Write UTF-8 without a BOM; app.js and index.html carry curly quotes and
  # em dashes, and a BOM would break the strict-mode script.
  [System.IO.File]::WriteAllText($path, $new, $utf8NoBom)
}

Set-Stamped -File 'sw.js' `
  -Pattern "(?m)^const CACHE = 'bookcurator-[^']*';" `
  -Replacement "const CACHE = 'bookcurator-$stamp';"

Set-Stamped -File 'app.js' `
  -Pattern "(?m)^const APP_VERSION = '[^']*';" `
  -Replacement "const APP_VERSION = '$stamp';"

Write-Output "Version stamped: $stamp"
