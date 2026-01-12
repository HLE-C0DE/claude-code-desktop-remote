# Extract readable data from Claude LevelDB
$leveldbPath = "$env:APPDATA\Claude\Local Storage\leveldb"

# Try to read .ldb files (compacted data) which might not be locked
$ldbFiles = Get-ChildItem -Path $leveldbPath -Filter "*.ldb" | Sort-Object LastWriteTime -Descending

Write-Output "=== Found LDB files ==="
$ldbFiles | ForEach-Object { Write-Output "$($_.Name) - $($_.Length) bytes - $($_.LastWriteTime)" }

foreach ($file in $ldbFiles) {
    Write-Output ""
    Write-Output "=== Reading: $($file.Name) ==="
    try {
        # Try with file share read
        $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.BinaryReader($stream)
        $bytes = $reader.ReadBytes([int]$stream.Length)
        $reader.Close()
        $stream.Close()

        $content = [System.Text.Encoding]::UTF8.GetString($bytes)

        # Find LSS-cc entries (session state)
        $lssMatches = [regex]::Matches($content, 'LSS-cc-local_[a-f0-9-]+')
        if ($lssMatches.Count -gt 0) {
            Write-Output "LSS-cc entries found:"
            $lssMatches | ForEach-Object { Write-Output "  $($_.Value)" } | Select-Object -Unique
        }

        # Find router state with path
        $routerMatches = [regex]::Matches($content, '"path":"(/[^"]*)"')
        if ($routerMatches.Count -gt 0) {
            Write-Output "Router paths:"
            $routerMatches | ForEach-Object { Write-Output "  $($_.Groups[1].Value)" } | Select-Object -Unique
        }

        # Find local session IDs
        $localMatches = [regex]::Matches($content, 'local_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
        if ($localMatches.Count -gt 0) {
            Write-Output "Local session IDs:"
            $localMatches | ForEach-Object { Write-Output "  $($_.Value)" } | Select-Object -Unique
        }
    }
    catch {
        Write-Output "  Error: $($_.Exception.Message)"
    }
}

# Also try Session Storage
Write-Output ""
Write-Output "=== Session Storage ==="
$sessionStoragePath = "$env:APPDATA\Claude\Session Storage"
if (Test-Path $sessionStoragePath) {
    Get-ChildItem -Path $sessionStoragePath | ForEach-Object { Write-Output $_.Name }
}

# Check WebStorage
Write-Output ""
Write-Output "=== WebStorage ==="
$webStoragePath = "$env:APPDATA\Claude\WebStorage"
if (Test-Path $webStoragePath) {
    Get-ChildItem -Path $webStoragePath -Recurse | ForEach-Object { Write-Output $_.FullName }
}
