# Find Claude named pipes
Write-Output "=== Searching for Claude pipes ==="

# Method 1: Using .NET
try {
    $pipes = [System.IO.Directory]::GetFiles("\\.\pipe\")
    $claudePipes = $pipes | Where-Object { $_ -match 'claude' }
    if ($claudePipes) {
        Write-Output "Found Claude pipes:"
        $claudePipes | ForEach-Object { Write-Output "  $_" }
    } else {
        Write-Output "No Claude pipes found via .NET method"
    }
} catch {
    Write-Output "Error with .NET method: $($_.Exception.Message)"
}

# Method 2: Using Get-ChildItem with proper path
Write-Output ""
Write-Output "=== All pipes containing 'claude' or 'mcp' ==="
try {
    $allPipes = Get-ChildItem "\\.\pipe\" -ErrorAction Stop
    $mcpPipes = $allPipes | Where-Object { $_.Name -match 'claude|mcp' }
    if ($mcpPipes) {
        $mcpPipes | ForEach-Object { Write-Output $_.Name }
    } else {
        Write-Output "No matching pipes found"
    }
} catch {
    Write-Output "Error: $($_.Exception.Message)"
}

# Method 3: Check specific pipe
Write-Output ""
Write-Output "=== Checking specific pipe ==="
$username = [Environment]::UserName
$pipePath = "\\.\pipe\claude-mcp-browser-bridge-$username"
Write-Output "Expected pipe: $pipePath"

# Try to connect to see if it exists
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "claude-mcp-browser-bridge-$username", [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(1000)  # 1 second timeout
    Write-Output "SUCCESS: Pipe exists and is connectable!"
    $pipe.Close()
} catch {
    Write-Output "Could not connect: $($_.Exception.Message)"
}
