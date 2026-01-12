# Script PowerShell pour activer une fenetre par PID
# Usage: powershell -File activate-window.ps1 -PID 12345

param(
    [Parameter(Mandatory=$true)]
    [int]$PID
)

$wshell = New-Object -ComObject wscript.shell
$wshell.AppActivate($PID) | Out-Null
Start-Sleep -Milliseconds 100
$wshell.AppActivate($PID) | Out-Null
Write-Output "OK"
