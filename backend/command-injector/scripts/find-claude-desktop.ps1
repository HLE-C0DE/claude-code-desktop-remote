# Script PowerShell pour trouver specifiquement Claude Desktop App
# Retourne: PID|ProcessName|WindowTitle ou rien

$claudeProcs = Get-Process | Where-Object {
    $_.ProcessName -eq 'Claude' -or
    $_.ProcessName -eq 'claude' -or
    ($_.MainWindowTitle -match 'Claude' -and $_.MainWindowTitle -notmatch 'Visual Studio|Code|Terminal')
} | Where-Object { $_.MainWindowTitle -ne '' }

if ($claudeProcs) {
    $proc = $claudeProcs | Select-Object -First 1
    Write-Output "$($proc.Id)|$($proc.ProcessName)|$($proc.MainWindowTitle)"
}
