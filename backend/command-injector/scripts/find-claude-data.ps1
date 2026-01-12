# Trouver les dossiers Claude dans AppData
Write-Output "=== Recherche dans AppData\Roaming ==="
Get-ChildItem -Path "$env:APPDATA" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'claude|anthropic' } |
    ForEach-Object { Write-Output $_.FullName }

Write-Output ""
Write-Output "=== Recherche dans AppData\Local ==="
Get-ChildItem -Path "$env:LOCALAPPDATA" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'claude|anthropic' } |
    ForEach-Object { Write-Output $_.FullName }

Write-Output ""
Write-Output "=== Recherche dans ProgramData ==="
Get-ChildItem -Path "$env:ProgramData" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'claude|anthropic' } |
    ForEach-Object { Write-Output $_.FullName }

Write-Output ""
Write-Output "=== Contenu de ~/.claude (si existe) ==="
$claudeDir = Join-Path $env:USERPROFILE ".claude"
if (Test-Path $claudeDir) {
    Get-ChildItem -Path $claudeDir -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Select-Object FullName |
        ForEach-Object { Write-Output $_.FullName }
}

Write-Output ""
Write-Output "=== Fichiers JSON dans Claude AppData (si existe) ==="
$claudeAppData = Join-Path $env:APPDATA "Claude"
if (Test-Path $claudeAppData) {
    Get-ChildItem -Path $claudeAppData -Filter "*.json" -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Output $_.FullName }
}

$claudeLocalAppData = Join-Path $env:LOCALAPPDATA "Claude"
if (Test-Path $claudeLocalAppData) {
    Get-ChildItem -Path $claudeLocalAppData -Filter "*.json" -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 50 |
        ForEach-Object { Write-Output $_.FullName }
}
