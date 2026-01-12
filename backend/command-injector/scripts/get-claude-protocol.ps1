# Get Claude URL protocol handler details
Write-Output "=== Claude URL Protocol ==="
Get-ItemProperty -Path 'HKCU:\Software\Classes\claude' -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "=== Shell Command ==="
Get-ItemProperty -Path 'HKCU:\Software\Classes\claude\shell\open\command' -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "=== Default Icon ==="
Get-ItemProperty -Path 'HKCU:\Software\Classes\claude\DefaultIcon' -ErrorAction SilentlyContinue
