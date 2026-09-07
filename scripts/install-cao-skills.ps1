[CmdletBinding()]
param(
    [string]$SourceRoot = (Join-Path $PSScriptRoot '..\.agents\skills'),
    [string]$ClaudeSourceRoot = (Join-Path $PSScriptRoot '..\.agents\claude-skills'),
    [string]$CodexDestinationRoot = (Join-Path $env:USERPROFILE '.codex\skills'),
    [string]$ClaudeDestinationRoot = (Join-Path $env:USERPROFILE '.claude\skills')
)

$ErrorActionPreference = 'Stop'
$skillNames = @('cao-yaml', 'cao-wayfinder', 'cao-to-spec', 'cao-to-tickets', 'cao-implement')
$sourceRootPath = (Resolve-Path -LiteralPath $SourceRoot).Path
$claudeSourceRootPath = (Resolve-Path -LiteralPath $ClaudeSourceRoot).Path

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

foreach ($installation in @(
    @{ SourceRoot = $sourceRootPath; DestinationRoot = $CodexDestinationRoot },
    @{ SourceRoot = $claudeSourceRootPath; DestinationRoot = $ClaudeDestinationRoot }
)) {
    $destinationRoot = $installation.DestinationRoot
    if (-not (Test-Path -LiteralPath $destinationRoot)) {
        New-Item -ItemType Directory -Path $destinationRoot | Out-Null
    }

    foreach ($skillName in $skillNames) {
        $source = Join-Path $installation.SourceRoot $skillName
        $destination = Join-Path $destinationRoot $skillName

        if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
            throw "Missing skill source: $source"
        }

        if (Test-Path -LiteralPath $destination) {
            $existing = Get-Item -LiteralPath $destination -Force
            $target = if ($existing.LinkType -eq 'Junction') { [string]$existing.Target } else { $null }
            if ($target -and (Get-NormalizedPath $target) -eq (Get-NormalizedPath $source)) {
                Write-Host "Already linked: $destination"
                continue
            }

            throw "Refusing to replace existing path: $destination"
        }

        New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
        $installed = Get-Item -LiteralPath $destination -Force
        if ($installed.LinkType -ne 'Junction' -or (Get-NormalizedPath ([string]$installed.Target)) -ne (Get-NormalizedPath $source)) {
            throw "Failed to verify skill junction: $destination"
        }

        Write-Host "Installed: $destination -> $source"
    }
}