<#
.SYNOPSIS
    Opens the Windows Firewall for Riff's phone (Subsonic) listener.

.DESCRIPTION
    Adds an inbound TCP rule so the Navic app on your phone can reach Riff
    on your local network. Must run as Administrator.

    By default the rule applies to the Private and Domain network profiles.
    Windows treats most home Wi-Fi networks as "Public" until you change it,
    so use -SetPrivate to switch the current network to Private as well, or
    -IncludePublic to open the port for Public networks too (not recommended
    on untrusted Wi-Fi).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1 -SetPrivate

.NOTES
    This script only touches Windows Firewall. It does not open your router.
#>

[CmdletBinding()]
param(
    [int]$Port = 6767,
    [switch]$IncludePublic,
    [switch]$SetPrivate
)

$ErrorActionPreference = 'Stop'
$RuleName = "Riff Mobile (Subsonic $Port)"

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host 'Requesting administrator rights...' -ForegroundColor Yellow
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-Port', $Port
    )
    if ($IncludePublic) { $arguments += '-IncludePublic' }
    if ($SetPrivate) { $arguments += '-SetPrivate' }
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null
        exit 0
    } catch {
        Write-Host 'Could not elevate. Run this script from an Administrator PowerShell window.' -ForegroundColor Red
        exit 1
    }
}

Write-Host "Riff phone access — opening TCP port $Port" -ForegroundColor Cyan

# Remove an older rule with the same name so repeated runs stay clean.
$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Remove-NetFirewallRule -DisplayName $RuleName | Out-Null
    Write-Host '  removed previous rule'
}

$profiles = @('Private', 'Domain')
if ($IncludePublic) { $profiles += 'Public' }

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Description 'Allows the Navic phone app to reach the Riff Subsonic server on the local network.' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile $profiles `
    -EdgeTraversalPolicy Block | Out-Null

Write-Host "  added inbound TCP $Port for profile(s): $($profiles -join ', ')" -ForegroundColor Green

if ($SetPrivate) {
    try {
        $publicProfiles = Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.NetworkCategory -eq 'Public' }
        if (-not $publicProfiles) {
            Write-Host '  no Public network profiles to change' -ForegroundColor DarkGray
        } else {
            foreach ($profile in $publicProfiles) {
                Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private
                Write-Host "  set network '$($profile.Name)' to Private" -ForegroundColor Green
            }
        }
    } catch {
        Write-Host "  could not change network category: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'Done. In Riff, open Settings → Phone & Navic and enable phone access.'
Write-Host "Then add this server in Navic using the address shown there (port $Port)."
Write-Host ''
Write-Host 'Tip: if the phone still cannot connect, make sure the PC and phone are on'
Write-Host 'the same Wi-Fi and that the Riff window is running.'
