# List all Claude Code Desktop sessions
$sessionsPath = "$env:APPDATA\Claude\claude-code-sessions"

if (Test-Path $sessionsPath) {
    Write-Output "=== Session files ==="
    Get-ChildItem -Path $sessionsPath -Recurse -Filter "*.json" |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object {
            Write-Output ""
            Write-Output "File: $($_.FullName)"
            Write-Output "Modified: $($_.LastWriteTime)"
            $content = Get-Content $_.FullName -Raw | ConvertFrom-Json
            Write-Output "SessionId: $($content.sessionId)"
            Write-Output "CliSessionId: $($content.cliSessionId)"
            Write-Output "Title: $($content.title)"
            Write-Output "CWD: $($content.cwd)"
        }
} else {
    Write-Output "Sessions path not found: $sessionsPath"
}
