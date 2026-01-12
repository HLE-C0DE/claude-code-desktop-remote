# Script PowerShell pour trouver les fenetres Claude
# Retourne: PID|ProcessName|WindowTitle

$results = @()

Get-Process | Where-Object {
    $_.MainWindowTitle -ne '' -and (
        $_.ProcessName -match 'claude|Claude' -or
        $_.MainWindowTitle -match 'claude|Claude'
    )
} | ForEach-Object {
    $results += "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)"
}

$results | ForEach-Object { Write-Output $_ }
