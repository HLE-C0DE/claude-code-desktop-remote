# Read full Session Storage content
$sessionStoragePath = "$env:APPDATA\Claude\Session Storage"

foreach ($file in Get-ChildItem -Path $sessionStoragePath -Filter "*.log") {
    Write-Output "=== Reading: $($file.Name) ==="
    try {
        $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.BinaryReader($stream)
        $bytes = $reader.ReadBytes([int]$stream.Length)
        $reader.Close()
        $stream.Close()

        # Convert to string, keeping only printable ASCII
        $chars = @()
        foreach ($b in $bytes) {
            if ($b -ge 32 -and $b -le 126) {
                $chars += [char]$b
            } else {
                $chars += ' '
            }
        }
        $content = -join $chars

        # Look for JSON patterns
        Write-Output ""
        Write-Output "Looking for JSON with pendingMessages..."

        # Extract any {...} that contains pendingMessages
        $pattern = '\{[^{}]*pendingMessages[^{}]*(?:\{[^{}]*\}[^{}]*)*\}'
        $matches = [regex]::Matches($content, $pattern)

        foreach ($m in $matches) {
            Write-Output "Found: $($m.Value)"
        }

        # Look for session_ IDs
        $sessionPattern = 'session_[A-Za-z0-9]+'
        $sessionMatches = [regex]::Matches($content, $sessionPattern) | Select-Object -ExpandProperty Value -Unique
        if ($sessionMatches) {
            Write-Output ""
            Write-Output "Session IDs found:"
            $sessionMatches | ForEach-Object { Write-Output "  $_" }
        }

    } catch {
        Write-Output "Error: $($_.Exception.Message)"
    }
}
