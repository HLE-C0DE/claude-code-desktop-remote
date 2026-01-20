# ========================================================
# ClaudeCode_Remote - Launcher Script
# ========================================================
# Script unifie qui lance le serveur + tunnel Cloudflare
# et ouvre automatiquement une page web avec QR code
# ========================================================

$ErrorActionPreference = "Stop"

# Definir l'encodage UTF-8 pour l'affichage correct
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Nettoyer l'ecran
Clear-Host

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "          ClaudeCode_Remote - Launcher                      " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Variables globales
$serverProcess = $null
$cloudflaredProcess = $null
$cloudflaredLogFile = $null
$cloudflaredErrFile = $null

# ========================================================
# Etape 0 : Gestion de Claude Desktop (mode debug CDP)
# ========================================================

Write-Host "[0/4] Lancement de Claude Desktop en mode debug..." -ForegroundColor Yellow

# Chemin vers Claude Desktop (recherche automatique de la derniere version)
$claudeBaseDir = "$env:LOCALAPPDATA\AnthropicClaude"
$claudeAppDirs = Get-ChildItem -Path $claudeBaseDir -Directory -Filter "app-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending
if ($claudeAppDirs) {
    $claudeExePath = Join-Path $claudeAppDirs[0].FullName "claude.exe"
} else {
    Write-Host "[ERREUR] Aucune version de Claude Desktop trouvee dans $claudeBaseDir" -ForegroundColor Red
    $claudeExePath = $null  # Pas de fallback hardcode
}

# Fonction pour verifier si le port 9222 est utilise par un processus actif
function Test-Port9222 {
    $connection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
    if (-not $connection) {
        return $false
    }

    # Verifier si le processus proprietaire existe toujours
    $processPID = $connection.OwningProcess
    $process = Get-Process -Id $processPID -ErrorAction SilentlyContinue

    # Si le processus n'existe plus, le port est en etat "fantome" (TIME_WAIT)
    # On considere le port comme libre car il sera libere bientot
    if (-not $process) {
        return $false
    }

    return $true
}

# Fonction pour attendre que tous les processus Claude soient fermes
function Wait-ClaudeClosed {
    param([int]$MaxWaitSeconds = 15)

    $waited = 0
    while ($waited -lt $MaxWaitSeconds) {
        $claudeProcesses = Get-Process -Name "claude" -ErrorAction SilentlyContinue
        $portInUse = Test-Port9222

        if (-not $claudeProcesses -and -not $portInUse) {
            return $true
        }

        Start-Sleep -Seconds 1
        $waited++
        Write-Host "." -NoNewline -ForegroundColor Gray
    }
    Write-Host "" # Nouvelle ligne
    return $false
}

# Fonction pour verifier si Claude est en mode debug
function Test-ClaudeDebugMode {
    # Verifier si le port 9222 est ouvert
    if (-not (Test-Port9222)) {
        return $false
    }

    # Verifier que c'est bien Claude qui utilise le port
    $connection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
    if (-not $connection) {
        return $false
    }

    $processPID = $connection.OwningProcess
    $process = Get-Process -Id $processPID -ErrorAction SilentlyContinue

    if ($process -and $process.ProcessName -eq "claude") {
        return $true
    }

    return $false
}

# Verifier si Claude est deja en mode debug
$claudeAlreadyInDebug = Test-ClaudeDebugMode

if ($claudeAlreadyInDebug) {
    Write-Host "  Claude Desktop est deja en mode debug (port 9222)" -ForegroundColor Green
    Write-Host "[OK] Mode debug deja actif, reutilisation de l'instance existante" -ForegroundColor Green
    $skipClaudeLaunch = $true
} else {
    $skipClaudeLaunch = $false

    # Verifier si le port 9222 est utilise par autre chose
    if (Test-Port9222) {
        Write-Host "  Port 9222 deja utilise, verification du processus..." -ForegroundColor Gray

        # Trouver le processus qui utilise le port
        $connection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
        if ($connection) {
            $processPID = $connection.OwningProcess
            $process = Get-Process -Id $processPID -ErrorAction SilentlyContinue

            if ($process -and $process.ProcessName -eq "claude") {
                Write-Host "  Claude est ouvert mais PAS en mode debug, fermeture..." -ForegroundColor Gray
            } else {
                Write-Host "  Port utilise par: $($process.ProcessName) (PID: $processPID)" -ForegroundColor Yellow
            }
        }
    }

    # Verifier si Claude Desktop est ouvert (sans mode debug)
    $claudeProcesses = Get-Process -Name "claude" -ErrorAction SilentlyContinue

    if ($claudeProcesses) {
        Write-Host "  Claude Desktop est ouvert ($($claudeProcesses.Count) processus), fermeture..." -ForegroundColor Gray

        # Fermer tous les processus Claude
        Stop-Process -Name "claude" -Force -ErrorAction SilentlyContinue

        # Attendre que tous les processus soient fermes et que le port soit libere
        Write-Host "  Attente de la fermeture complete" -NoNewline -ForegroundColor Gray
        $closed = Wait-ClaudeClosed -MaxWaitSeconds 15

        if (-not $closed) {
            Write-Host "  [ATTENTION] Certains processus Claude n'ont pas pu etre fermes" -ForegroundColor Yellow

            # Forcer la fermeture des processus restants
            $remaining = Get-Process -Name "claude" -ErrorAction SilentlyContinue
            if ($remaining) {
                Write-Host "  Fermeture forcee des processus restants..." -ForegroundColor Gray
                $remaining | ForEach-Object {
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                }
                Start-Sleep -Seconds 2
            }

            # Verifier si le port est toujours utilise
            if (Test-Port9222) {
                $connection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
                if ($connection) {
                    $processPID = $connection.OwningProcess
                    Write-Host "  Fermeture du processus bloquant le port (PID: $processPID)..." -ForegroundColor Gray
                    Stop-Process -Id $processPID -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Seconds 2
                }
            }
        }

        Write-Host "  [OK] Claude Desktop ferme" -ForegroundColor Green
    }
}

# Fonction pour forcer la liberation d'un port TCP via API Windows
function Force-ClosePort {
    param([int]$Port)

    # Charger l'API Windows pour SetTcpEntry
    $signature = @'
[DllImport("iphlpapi.dll", SetLastError = true)]
public static extern int SetTcpEntry(ref MIB_TCPROW pTcpRow);

[StructLayout(LayoutKind.Sequential)]
public struct MIB_TCPROW {
    public int dwState;
    public int dwLocalAddr;
    public int dwLocalPort;
    public int dwRemoteAddr;
    public int dwRemotePort;
}
'@

    try {
        Add-Type -MemberDefinition $signature -Name "IPHelper" -Namespace "Win32" -ErrorAction Stop
    } catch {
        # Type deja charge, ignorer
    }

    # Recuperer les connexions sur le port
    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue

    foreach ($conn in $connections) {
        try {
            $row = New-Object Win32.IPHelper+MIB_TCPROW
            $row.dwState = 12  # DELETE_TCB - force la suppression

            # Convertir l'adresse IP locale
            $localAddr = [System.Net.IPAddress]::Parse($conn.LocalAddress)
            $row.dwLocalAddr = [BitConverter]::ToInt32($localAddr.GetAddressBytes(), 0)

            # Convertir le port (network byte order)
            $row.dwLocalPort = [System.Net.IPAddress]::HostToNetworkOrder([int16]$conn.LocalPort)

            # Adresse distante (0.0.0.0 pour LISTENING)
            if ($conn.RemoteAddress -eq "0.0.0.0" -or $conn.RemoteAddress -eq "::") {
                $row.dwRemoteAddr = 0
                $row.dwRemotePort = 0
            } else {
                $remoteAddr = [System.Net.IPAddress]::Parse($conn.RemoteAddress)
                $row.dwRemoteAddr = [BitConverter]::ToInt32($remoteAddr.GetAddressBytes(), 0)
                $row.dwRemotePort = [System.Net.IPAddress]::HostToNetworkOrder([int16]$conn.RemotePort)
            }

            $result = [Win32.IPHelper]::SetTcpEntry([ref]$row)
            return ($result -eq 0)
        } catch {
            return $false
        }
    }
    return $false
}

# Verifier et liberer le port 9222 si necessaire (seulement si on doit relancer Claude)
if (-not $skipClaudeLaunch) {
    $portConnection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
    if ($portConnection) {
    $ownerPID = $portConnection.OwningProcess
    $ownerProcess = Get-Process -Id $ownerPID -ErrorAction SilentlyContinue

    if (-not $ownerProcess) {
        # Le processus n'existe plus mais le port est en TIME_WAIT
        Write-Host "  Port 9222 en etat fantome, liberation forcee..." -ForegroundColor Gray

        # Forcer la fermeture via API Windows
        $forceResult = Force-ClosePort -Port 9222
        Start-Sleep -Seconds 1

        # Verifier si ca a marche
        $portConnection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
        if (-not $portConnection) {
            Write-Host "  [OK] Port 9222 libere" -ForegroundColor Green
        } else {
            # Attendre un peu plus si necessaire
            Write-Host "  Attente supplementaire" -NoNewline -ForegroundColor Gray
            $portFree = $false
            $waitAttempts = 0

            while (-not $portFree -and $waitAttempts -lt 5) {
                Start-Sleep -Seconds 1
                $waitAttempts++
                Write-Host "." -NoNewline -ForegroundColor Gray

                $portConnection = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
                if (-not $portConnection) {
                    $portFree = $true
                }
            }
            Write-Host "" # Nouvelle ligne

            if ($portFree) {
                Write-Host "  [OK] Port 9222 libere" -ForegroundColor Green
            } else {
                Write-Host "  [ATTENTION] Port toujours occupe, tentative de demarrage..." -ForegroundColor Yellow
            }
        }
    } else {
        # Un processus actif utilise le port
        Write-Host "  Port 9222 utilise par $($ownerProcess.ProcessName) (PID: $ownerPID)" -ForegroundColor Yellow

        if ($ownerProcess.ProcessName -eq "claude") {
            Write-Host "  Fermeture du processus Claude..." -ForegroundColor Gray
            Stop-Process -Id $ownerPID -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
        } else {
            Write-Host "[ERREUR] Le port 9222 est utilise par un autre programme: $($ownerProcess.ProcessName)" -ForegroundColor Red
            Write-Host "  Fermez ce programme et reessayez" -ForegroundColor Yellow
            Read-Host "Appuyez sur Entree pour quitter"
            exit 1
        }
    }
    }
}

# Lancer Claude Desktop en mode debug (seulement si necessaire)
if (-not $skipClaudeLaunch) {
    if (Test-Path $claudeExePath) {
        Write-Host "  Demarrage de Claude Desktop en mode debug (port 9222)..." -ForegroundColor Gray

        # Lancer Claude de maniere completement detachee via WMI
        # Cette methode garantit que Claude reste ouvert meme si ce script est interrompu
        $commandLine = "`"$claudeExePath`" --remote-debugging-port=9222"
        $null = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $commandLine

        # Attendre que le port 9222 soit ouvert (confirmation que le mode debug est actif)
        Write-Host "  Attente de l'activation du mode debug" -NoNewline -ForegroundColor Gray
        $debugReady = $false
        $attempts = 0
        $maxAttempts = 15

        while (-not $debugReady -and $attempts -lt $maxAttempts) {
            Start-Sleep -Seconds 1
            $attempts++
            Write-Host "." -NoNewline -ForegroundColor Gray

            # Verifier si le port 9222 est maintenant ouvert
            if (Test-Port9222) {
                $debugReady = $true
            }
        }
        Write-Host "" # Nouvelle ligne

        if ($debugReady) {
            Write-Host "[OK] Claude Desktop demarre en mode debug" -ForegroundColor Green
        } else {
            Write-Host "[ATTENTION] Le mode debug n'a peut-etre pas demarre correctement" -ForegroundColor Yellow
            Write-Host "  Le serveur fonctionnera en mode degrade (lecture fichiers uniquement)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[ERREUR] Claude Desktop non trouve: $claudeExePath" -ForegroundColor Red
        $quit = Read-Host "Voulez-vous quitter ? (Y/N)"
        if ($quit -eq "Y" -or $quit -eq "y") {
            exit 1
        }
    }
}

Write-Host ""

# ========================================================
# Etape 1 : Demander le PIN de securite
# ========================================================

# Garder la fenetre au premier plan pendant la configuration
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
"@
$consoleHandle = [Win32]::GetConsoleWindow()
[Win32]::SetForegroundWindow($consoleHandle) | Out-Null

Write-Host "[1/4] Configuration de la securite..." -ForegroundColor Yellow
Write-Host ""

$pin = ""
while ($pin.Length -ne 6 -or $pin -notmatch '^\d{6}$') {
    $pin = Read-Host "Entrez un PIN a 6 chiffres pour securiser l'acces"
    if ($pin.Length -ne 6 -or $pin -notmatch '^\d{6}$') {
        Write-Host "  Le PIN doit contenir exactement 6 chiffres" -ForegroundColor Red
    }
}

Write-Host "[OK] PIN configure" -ForegroundColor Green
Write-Host ""

# Sauvegarder le PIN dans une variable d'environnement pour le serveur
$env:CLAUDECODE_PIN = $pin

# ========================================================
# Etape 2 : Demarrer le serveur Node.js
# ========================================================

Write-Host "[2/4] Demarrage du serveur..." -ForegroundColor Yellow

# Creer le dossier logs s'il n'existe pas
$logsDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# Fichiers de log du serveur (stdout et stderr separes)
$serverLogFile = Join-Path $logsDir "server.log"
$serverErrFile = Join-Path $logsDir "server.err.log"

try {
    # Demarrer le serveur en arriere-plan avec redirection des logs
    # Le PIN est passe en argument de ligne de commande et lu par le serveur
    $serverArgs = "backend/server.js --pin=$pin"
    $serverProcess = Start-Process -FilePath "node" -ArgumentList $serverArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLogFile -RedirectStandardError $serverErrFile

    # Attendre que le serveur demarre
    Start-Sleep -Seconds 3

    # Verifier que le serveur est bien demarre
    $healthCheck = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "[OK] Serveur demarre avec succes" -ForegroundColor Green
    Write-Host "     Logs serveur : $serverLogFile" -ForegroundColor Gray
}
catch {
    Write-Host "[ERREUR] Le serveur n'a pas pu demarrer" -ForegroundColor Red
    Write-Host "   Details : $($_.Exception.Message)" -ForegroundColor Red
    if ($serverProcess) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Read-Host "Appuyez sur Entree pour quitter"
    exit 1
}

Write-Host ""

# ========================================================
# Etape 2 : Creer le tunnel Cloudflare
# ========================================================

Write-Host "[3/4] Creation du tunnel Cloudflare..." -ForegroundColor Yellow

# Fichiers temporaires separes pour stdout et stderr
$cloudflaredLogFile = "$env:TEMP\cloudflared_out_$(Get-Random -Maximum 99999).log"
$cloudflaredErrFile = "$env:TEMP\cloudflared_err_$(Get-Random -Maximum 99999).log"

try {
    # Demarrer cloudflared avec fichiers separes pour stdout et stderr
    $cloudflaredProcess = Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "--url", "http://localhost:3000" -RedirectStandardOutput $cloudflaredLogFile -RedirectStandardError $cloudflaredErrFile -WindowStyle Hidden -PassThru

    # Attendre et extraire l'URL du tunnel
    $tunnelUrl = $null
    $attempts = 0
    $maxAttempts = 30

    while (-not $tunnelUrl -and $attempts -lt $maxAttempts) {
        Start-Sleep -Seconds 1
        $attempts++

        # Chercher l'URL dans les deux fichiers de log
        $logContent = ""
        if (Test-Path $cloudflaredLogFile) {
            $logContent += Get-Content $cloudflaredLogFile -Raw -ErrorAction SilentlyContinue
        }
        if (Test-Path $cloudflaredErrFile) {
            $logContent += Get-Content $cloudflaredErrFile -Raw -ErrorAction SilentlyContinue
        }

        # Extraire l'URL du tunnel (format : https://xxx.trycloudflare.com)
        if ($logContent -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $tunnelUrl = $matches[1]
        }

        # Animation simple pour montrer que ca charge
        if ($attempts % 3 -eq 0) {
            Write-Host "." -NoNewline -ForegroundColor Yellow
        }
    }

    Write-Host "" # Nouvelle ligne apres les points

    if (-not $tunnelUrl) {
        throw "Impossible de recuperer l'URL du tunnel apres $maxAttempts tentatives"
    }

    Write-Host "[OK] Tunnel cree avec succes" -ForegroundColor Green
    Write-Host ""
}
catch {
    Write-Host "[ERREUR] Le tunnel n'a pas pu etre cree" -ForegroundColor Red
    Write-Host "   Details : $($_.Exception.Message)" -ForegroundColor Red

    # Cleanup
    if ($serverProcess) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($cloudflaredProcess) {
        Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($cloudflaredLogFile -and (Test-Path -Path $cloudflaredLogFile)) {
        Remove-Item -Path $cloudflaredLogFile -Force -ErrorAction SilentlyContinue
    }
    if ($cloudflaredErrFile -and (Test-Path -Path $cloudflaredErrFile)) {
        Remove-Item -Path $cloudflaredErrFile -Force -ErrorAction SilentlyContinue
    }

    Read-Host "Appuyez sur Entree pour quitter"
    exit 1
}

# ========================================================
# Etape 3 : Ouvrir la page launcher avec QR code
# ========================================================

Write-Host "============================================================" -ForegroundColor Green
Write-Host "                    TOUT EST PRET !                         " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "URL du tunnel : " -NoNewline -ForegroundColor Cyan
Write-Host $tunnelUrl -ForegroundColor White
Write-Host ""
Write-Host "PIN de securite : " -NoNewline -ForegroundColor Cyan
Write-Host $pin -ForegroundColor White
Write-Host ""
Write-Host "[4/4] Ouverture de la page launcher..." -ForegroundColor Yellow

# Construire l'URL de la page launcher avec l'URL du tunnel en parametre
$launcherUrl = "http://localhost:3000/launcher.html?url=" + [System.Uri]::EscapeDataString($tunnelUrl)

# Ouvrir la page dans le navigateur par defaut
Start-Process $launcherUrl

# Copier l'URL dans le presse-papier
try {
    Set-Clipboard -Value $tunnelUrl
    Write-Host "[OK] URL copiee dans le presse-papier" -ForegroundColor Green
}
catch {
    # Le presse-papier n'est pas disponible (mode serveur, etc.)
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Gray
Write-Host ""
Write-Host "  Utilisez la page web pour partager le lien ou scanner le QR code" -ForegroundColor White
Write-Host "  Les utilisateurs devront entrer le PIN : $pin" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Pour arreter : Appuyez sur Ctrl+C ou utilisez le bouton dans l'interface" -ForegroundColor White
Write-Host ""
Write-Host "============================================================" -ForegroundColor Gray
Write-Host ""

# ========================================================
# Etape 4 : Garder le script actif et gerer l'arret propre
# ========================================================

# Fonction de nettoyage
function Cleanup {
    Write-Host ""
    Write-Host "Arret en cours..." -ForegroundColor Yellow

    # Arreter cloudflared
    if ($cloudflaredProcess -and -not $cloudflaredProcess.HasExited) {
        Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  - Tunnel Cloudflare arrete" -ForegroundColor Gray
    }

    # Arreter le serveur Node
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  - Serveur Node.js arrete" -ForegroundColor Gray
    }

    # Nettoyer les processus orphelins cloudflared
    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Nettoyer les processus Node.js qui ecoutent sur le port 3000
    $nodeOnPort = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    if ($nodeOnPort) {
        $nodeOnPort | ForEach-Object {
            $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq "node") {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Host "  - Processus Node.js orphelin arrete (PID: $($proc.Id))" -ForegroundColor Gray
            }
        }
    }

    # Supprimer les fichiers de log
    if ($cloudflaredLogFile -and (Test-Path -Path $cloudflaredLogFile)) {
        Remove-Item -Path $cloudflaredLogFile -Force -ErrorAction SilentlyContinue
    }
    if ($cloudflaredErrFile -and (Test-Path -Path $cloudflaredErrFile)) {
        Remove-Item -Path $cloudflaredErrFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Arret termine avec succes" -ForegroundColor Green
    Write-Host ""
}

# Enregistrer le handler de nettoyage pour Ctrl+C
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Cleanup }

# Desactiver le message "Terminate batch job (Y/N)?" de Windows
[Console]::TreatControlCAsInput = $true

try {
    # Boucle infinie pour garder le script actif
    while ($true) {
        # Verifier si une touche est pressee (Ctrl+C)
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            # Ctrl+C = touche C avec modificateur Ctrl
            if ($key.Key -eq 'C' -and $key.Modifiers -eq 'Control') {
                Write-Host ""
                Write-Host "Ctrl+C detecte, arret en cours..." -ForegroundColor Yellow
                break
            }
        }

        Start-Sleep -Milliseconds 200

        # Verifier si cloudflared est toujours actif
        if ($cloudflaredProcess.HasExited) {
            Write-Host ""
            Write-Host "[ATTENTION] Le tunnel Cloudflare s'est arrete de maniere inattendue" -ForegroundColor Yellow
            break
        }

        # Verifier si le serveur est toujours actif
        if ($serverProcess.HasExited) {
            Write-Host ""
            Write-Host "[ATTENTION] Le serveur Node.js s'est arrete" -ForegroundColor Yellow
            break
        }
    }
}
catch {
    # Autre interruption
}
finally {
    # Nettoyage final
    Cleanup

    # Attendre une touche avant de fermer la fenetre
    Write-Host "Appuyez sur une touche pour fermer..." -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
