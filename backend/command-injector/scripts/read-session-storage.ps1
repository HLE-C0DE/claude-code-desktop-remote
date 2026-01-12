# Read Session Storage from Claude Desktop
$sessionStoragePath = "$env:APPDATA\Claude\Session Storage"

# Find the .ldb file
$ldbFile = Get-ChildItem -Path $sessionStoragePath -Filter "*.ldb" | Select-Object -First 1

if ($ldbFile) {
    Write-Output "=== Reading: $($ldbFile.FullName) ==="
    try {
        $stream = [System.IO.File]::Open($ldbFile.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.BinaryReader($stream)
        $bytes = $reader.ReadBytes([int]$stream.Length)
        $reader.Close()
        $stream.Close()

        $content = [System.Text.Encoding]::UTF8.GetString($bytes)

        # Find session-pending-messages
        Write-Output ""
        Write-Output "=== Looking for session-pending-messages ==="
        if ($content -match 'session-pending-messages') {
            Write-Output "Found session-pending-messages!"
            # Extract the JSON part
            $matches = [regex]::Matches($content, 'session-pending-messages[^\{]*(\{[^\}]+\})')
            foreach ($m in $matches) {
                Write-Output $m.Value
            }
        } else {
            Write-Output "Not found in this file"
        }

        # Find any JSON-like structures with sessionId
        Write-Output ""
        Write-Output "=== Looking for sessionId patterns ==="
        $sessionMatches = [regex]::Matches($content, '\{[^}]*sessionId[^}]*\}')
        foreach ($m in $sessionMatches | Select-Object -First 5) {
            Write-Output $m.Value
        }

        # Raw content around session-pending
        Write-Output ""
        Write-Output "=== Raw search for 'pending' ==="
        $pendingIdx = $content.IndexOf("pending")
        if ($pendingIdx -gt 0) {
            $start = [Math]::Max(0, $pendingIdx - 50)
            $length = [Math]::Min(500, $content.Length - $start)
            Write-Output $content.Substring($start, $length)
        }

    } catch {
        Write-Output "Error: $($_.Exception.Message)"
    }
}

# Also check the .log file
$logFile = Get-ChildItem -Path $sessionStoragePath -Filter "*.log" | Select-Object -First 1
if ($logFile) {
    Write-Output ""
    Write-Output "=== Reading LOG: $($logFile.FullName) ==="
    try {
        $stream = [System.IO.File]::Open($logFile.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.BinaryReader($stream)
        $bytes = $reader.ReadBytes([int]$stream.Length)
        $reader.Close()
        $stream.Close()

        $content = [System.Text.Encoding]::UTF8.GetString($bytes)

        if ($content -match 'pending') {
            Write-Output "Found 'pending' in log file"
            $pendingIdx = $content.IndexOf("pending")
            if ($pendingIdx -gt 0) {
                $start = [Math]::Max(0, $pendingIdx - 100)
                $length = [Math]::Min(1000, $content.Length - $start)
                Write-Output $content.Substring($start, $length)
            }
        }
    } catch {
        Write-Output "Error reading log: $($_.Exception.Message)"
    }
}
