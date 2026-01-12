# Claude Code Mobile Monitor - Tunnel Starter with QR Code
# This script starts the server and cloudflare tunnel, then displays a QR code

$ErrorActionPreference = "SilentlyContinue"

# Colors
function Write-Color($text, $color) {
    Write-Host $text -ForegroundColor $color
}

# QR Code generation using block characters
function Show-QRCode($url) {
    Write-Host ""
    Write-Color "  Scannez ce QR code avec votre telephone :" "Cyan"
    Write-Host ""

    # Use online API to get QR code link
    $qrApiUrl = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=$([System.Uri]::EscapeDataString($url))"

    # Generate ASCII QR code using PowerShell
    try {
        # Simple approach: show the API URL and try to generate ASCII art
        $qrText = @"

    Ouvrez ce lien dans un navigateur pour voir le QR code:
    $qrApiUrl

    Ou copiez directement l'URL du tunnel:
    $url

"@
        Write-Host $qrText -ForegroundColor Yellow

        # Try to open QR code in default browser
        Write-Host "  Ouverture du QR code dans le navigateur..." -ForegroundColor Gray
        Start-Process $qrApiUrl

    } catch {
        Write-Host "  (Utilisez l'URL ci-dessus)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Color "========================================================" "White"
Write-Color "   Demarrage du serveur local..." "White"
Write-Color "========================================================" "White"
Write-Host ""

# Start Node server in background
$serverJob = Start-Process -FilePath "node" -ArgumentList "backend/server.js" -WindowStyle Minimized -PassThru

Write-Host "  Attente du demarrage du serveur..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# Check if server is running
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Color "  [OK] Serveur demarre sur http://localhost:3000" "Green"
} catch {
    Write-Color "  [ERREUR] Le serveur n'a pas demarre correctement" "Red"
    if ($serverJob) { Stop-Process -Id $serverJob.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

Write-Host ""
Write-Color "========================================================" "White"
Write-Color "   Creation du tunnel Cloudflare..." "White"
Write-Color "========================================================" "White"
Write-Host ""
Write-Host "  Patientez, l'URL va s'afficher..." -ForegroundColor Gray
Write-Host ""

# Start cloudflared and capture output
$tempFile = "$env:TEMP\cloudflared_$([guid]::NewGuid().ToString().Substring(0,8)).log"

$cloudflaredProcess = Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "--url", "http://localhost:3000" -RedirectStandardError $tempFile -WindowStyle Hidden -PassThru

# Wait for URL to appear in logs
$tunnelUrl = $null
$attempts = 0
$maxAttempts = 30

while (-not $tunnelUrl -and $attempts -lt $maxAttempts) {
    Start-Sleep -Seconds 1
    $attempts++

    if (Test-Path $tempFile) {
        $content = Get-Content $tempFile -Raw -ErrorAction SilentlyContinue
        if ($content -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $tunnelUrl = $matches[1]
        }
    }
}

if ($tunnelUrl) {
    Write-Host ""
    Write-Color "========================================================" "Green"
    Write-Color "   TUNNEL ACTIF !" "Green"
    Write-Color "========================================================" "Green"
    Write-Host ""
    Write-Color "   URL: $tunnelUrl" "White"
    Write-Host ""

    # Show QR code
    Show-QRCode $tunnelUrl

    # Copy to clipboard
    try {
        Set-Clipboard -Value $tunnelUrl
        Write-Host ""
        Write-Color "  [OK] URL copiee dans le presse-papier !" "Green"
    } catch {
        # Clipboard not available
    }

} else {
    Write-Color "  [ATTENTION] Impossible de recuperer l'URL automatiquement" "Yellow"
    Write-Host "  Verifiez les logs cloudflared ci-dessous:" -ForegroundColor Gray
    if (Test-Path $tempFile) {
        Get-Content $tempFile | Select-Object -Last 20
    }
}

Write-Host ""
Write-Color "========================================================" "White"
Write-Host ""
Write-Host "  Le tunnel est actif. Appuyez sur Ctrl+C pour arreter." -ForegroundColor Cyan
Write-Host ""
Write-Color "========================================================" "White"
Write-Host ""

# Keep script running and handle cleanup
try {
    # Wait for user to press Ctrl+C
    while ($true) {
        Start-Sleep -Seconds 1

        # Check if cloudflared is still running
        if ($cloudflaredProcess.HasExited) {
            Write-Color "  Le tunnel s'est arrete." "Yellow"
            break
        }
    }
} finally {
    # Cleanup on exit
    Write-Host ""
    Write-Host "  Arret en cours..." -ForegroundColor Gray

    if ($cloudflaredProcess -and -not $cloudflaredProcess.HasExited) {
        Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
    }

    if ($serverJob -and -not $serverJob.HasExited) {
        Stop-Process -Id $serverJob.Id -Force -ErrorAction SilentlyContinue
    }

    # Also kill any orphan node processes for this server
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -eq "Claude Monitor Server"
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }

    Write-Color "  [OK] Tunnel et serveur arretes." "Green"
}
