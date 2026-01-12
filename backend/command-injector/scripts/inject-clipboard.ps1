# Script PowerShell pour injecter du texte via clipboard
# Usage: powershell -File inject-clipboard.ps1 -PID 12345 -Text "message"

param(
    [Parameter(Mandatory=$true)]
    [int]$PID,

    [Parameter(Mandatory=$true)]
    [string]$Text
)

$wshell = New-Object -ComObject wscript.shell

# Copier dans le clipboard
Set-Clipboard -Value $Text

# Activer la fenetre
$wshell.AppActivate($PID) | Out-Null
Start-Sleep -Milliseconds 300

# Coller (Ctrl+V)
$wshell.SendKeys('^v')
Start-Sleep -Milliseconds 200

# Envoyer (Enter)
$wshell.SendKeys('{ENTER}')

Write-Output "OK"
