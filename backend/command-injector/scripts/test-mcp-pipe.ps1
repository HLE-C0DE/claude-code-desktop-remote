# Test MCP pipe communication with Claude Desktop
param(
    [string]$Tool = "read_page",
    [string]$ArgsJson = "{}"
)

$username = [Environment]::UserName
$pipeName = "claude-mcp-browser-bridge-$username"

Write-Output "=== Testing MCP Pipe Communication ==="
Write-Output "Pipe: \\.\pipe\$pipeName"
Write-Output "Tool: $Tool"
Write-Output "Args: $ArgsJson"

try {
    # Create pipe client
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)

    Write-Output ""
    Write-Output "Connecting to pipe..."
    $pipe.Connect(5000)  # 5 second timeout
    Write-Output "Connected!"

    # Create the MCP message
    $message = @{
        method = "execute_tool"
        params = @{
            client_id = "desktop"
            tool = $Tool
            args = $ArgsJson | ConvertFrom-Json
        }
    } | ConvertTo-Json -Depth 10 -Compress

    Write-Output ""
    Write-Output "Sending message: $message"

    # Convert to bytes
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $lengthBytes = [BitConverter]::GetBytes([uint32]$messageBytes.Length)

    # Send length prefix + message
    $pipe.Write($lengthBytes, 0, 4)
    $pipe.Write($messageBytes, 0, $messageBytes.Length)
    $pipe.Flush()

    Write-Output "Message sent! Waiting for response..."

    # Read response
    $lengthBuffer = New-Object byte[] 4
    $bytesRead = $pipe.Read($lengthBuffer, 0, 4)

    if ($bytesRead -eq 4) {
        $responseLength = [BitConverter]::ToUInt32($lengthBuffer, 0)
        Write-Output "Response length: $responseLength bytes"

        $responseBuffer = New-Object byte[] $responseLength
        $totalRead = 0
        while ($totalRead -lt $responseLength) {
            $read = $pipe.Read($responseBuffer, $totalRead, $responseLength - $totalRead)
            if ($read -eq 0) { break }
            $totalRead += $read
        }

        $responseJson = [System.Text.Encoding]::UTF8.GetString($responseBuffer)
        Write-Output ""
        Write-Output "=== Response ==="
        Write-Output $responseJson
    } else {
        Write-Output "Failed to read response length"
    }

    $pipe.Close()

} catch {
    Write-Output "Error: $($_.Exception.Message)"
    Write-Output $_.Exception.StackTrace
}
