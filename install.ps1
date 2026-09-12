# dsh-ide-lite installer (official dsh bundle install)
#
# Installs @justarook1e/dsh-ide-lite through the standard DSH plugin management
# pipeline (`dsh plugin --profile web add`), exactly like npm-registry bundles
# such as @dingyi222666/dsh-session-notification. The package declares
# `dsh.bundle` (see package.json / cordis.patch.yml), so the CLI's reconcile
# step automatically appends it to `dsh.profile.bundles`; nothing is copied
# into node_modules by hand and no user-layer patch is written.
#
# Source preference: the npm registry package when it exists (so upgrades are
# ordinary version bumps), then this script's own directory (a clone), then the
# GitHub repository. `-Source` forces one explicitly.
#
# Usage:
#   One-command (from GitHub):
#     irm https://raw.githubusercontent.com/justarook1e/dsh-ide-lite/main/install.ps1 | iex
#   Local clone:
#     .\install.ps1
#   Force a source:
#     .\install.ps1 -Source npm | github | local
#   Uninstall:
#     .\install.ps1 -Uninstall
#
# After install: restart DSH (loads the new bundle layer), then hard-refresh
# the web page (Ctrl+F5) so the browser picks up the client bundle.

param(
  [switch]$Uninstall,
  [string]$ProfileName = 'web',
  [string]$Dsh = '',
  [ValidateSet('auto', 'npm', 'github', 'local')]
  [string]$Source = 'auto'
)

$ErrorActionPreference = 'Stop'

function Resolve-DshInvocation {
  param([string]$Dsh)
  if (-not [string]::IsNullOrEmpty($Dsh)) { return @{ Exe = $Dsh; Script = $null } }
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  # Only a real executable/sh script is usable; an alias or function has no
  # Source, so fall through to the known installation paths.
  if ($cmd -and $cmd.Source) { return @{ Exe = $cmd.Source; Script = $null } }
  $fallback = Join-Path $env:USERPROFILE 'deepseek-harness\apps\cli\lib\bin.js'
  if (Test-Path -LiteralPath $fallback) { return @{ Exe = 'node'; Script = $fallback } }
  throw "dsh CLI not found on PATH; install dsh or pass -Dsh '<path-to-dsh-cli>'"
}

function Invoke-Dsh {
  param($Inv, [string[]]$Rest)
  # Child stdout flows straight to the console; the native exit code is
  # picked up by the caller via $LASTEXITCODE (never capture it here, or the
  # child's output lines would land in the assignment).
  if ($Inv.Script) { & $Inv.Exe $Inv.Script @Rest } else { & $Inv.Exe @Rest }
}

$dshInv = Resolve-DshInvocation -Dsh $Dsh

if ($Uninstall) {
  # The artifact id and the package name differ, and the profile's dependency
  # key is whichever spec it was installed from. Remove only the keys present,
  # so an uninstall never fails on a key that was never installed.
  $profileManifest = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName\package.json"
  $present = @()
  if (Test-Path -LiteralPath $profileManifest) {
    $deps = (Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies
    foreach ($key in @('@justarook1e/dsh-ide-lite', 'dsh-file-edit')) {
      if ($deps -and $deps.PSObject.Properties.Name -contains $key) { $present += $key }
    }
  }
  if ($present.Count -eq 0) {
    "nothing to remove: no dsh-ide-lite / dsh-file-edit dependency in profile '$ProfileName'."
    return
  }
  "removing from profile '$ProfileName': $($present -join ', ') ..."
  Invoke-Dsh $dshInv (@('plugin', '--profile', $ProfileName, 'remove') + $present)
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin remove failed with exit code $LASTEXITCODE" }
  ""
  "Uninstall done. Restart DSH to apply."
  return
}

# Package source precedence: npm registry (the managed upgrade path, so
# `add @latest` moves a version range) → this script's own directory (a clone /
# checkout) → the GitHub repository. `irm | iex` gives no $PSScriptRoot, and
# before the first npm publish the registry probe simply falls through.
$npmSpec = '@justarook1e/dsh-ide-lite@latest'
$npmVersion = (npm view '@justarook1e/dsh-ide-lite' version 2>$null | Select-Object -First 1)
$haveNpm = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($npmVersion)
$haveLocal = [bool]($PSScriptRoot) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json'))

if ($Source -eq 'auto') {
  if ($haveNpm) { $Source = 'npm' } elseif ($haveLocal) { $Source = 'local' } else { $Source = 'github' }
}

$legacy = $false
$Spec = $npmSpec
switch ($Source) {
  'npm' {
    if (-not $haveNpm) {
      throw "no '@justarook1e/dsh-ide-lite' version is published on npm yet; re-run with -Source github or -Source local"
    }
    "installing from npm: $npmSpec (published $($npmVersion.Trim()))"
  }
  'local' {
    if (-not $haveLocal) { throw "-Source local needs package.json beside this script" }
    $Spec = "file:$PSScriptRoot"
    "installing from local checkout: $PSScriptRoot"
  }
  'github' {
    $Spec = 'github:justarook1e/dsh-ide-lite'
    "installing from GitHub: $Spec"
  }
}

# Migrate off the pre-npm artifact: the old `dsh-file-edit` git dependency is
# the same plugin under its former id, so leaving both would mount two copies.
$profileManifest = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName\package.json"
if (Test-Path -LiteralPath $profileManifest) {
  $deps = (Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies
  if ($deps -and ($deps.PSObject.Properties.Name -contains 'dsh-file-edit')) {
    "migrating: removing the legacy 'dsh-file-edit' dependency ..."
    Invoke-Dsh $dshInv @('plugin', '--profile', $ProfileName, 'remove', 'dsh-file-edit')
    if ($LASTEXITCODE -ne 0) { throw "removing the legacy dsh-file-edit dependency failed with exit code $LASTEXITCODE" }
    $legacy = $true
  }
}

Invoke-Dsh $dshInv @('plugin', '--profile', $ProfileName, 'add', $Spec)
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

""
"@justarook1e/dsh-ide-lite installed into profile '$ProfileName' (managed bundle)."
"Next steps:"
"  1. restart DSH (loads the new bundle layer)"
"  2. hard-refresh the web page (Ctrl+F5) so the browser picks up the client bundle"
"  3. verify: sidebar workspace tree + the Files tab + modified-file bar appear,"
"     and the console shows '[dsh-file-edit] guard v1.31.0' (the runtime id stays dsh-file-edit)"
if ($legacy) {
  "  4. the legacy 'dsh-file-edit' dependency was removed; your review state in"
  "     ~/.dsh/dsh-file-edit-state/ carries over unchanged (no migration needed)"
}
