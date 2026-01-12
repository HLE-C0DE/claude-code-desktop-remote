# Claude Code Mobile Monitor - Script de démarrage PowerShell

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Claude Code Mobile Monitor" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Vérifier si Node.js est installé
try {
    $nodeVersion = node --version
    Write-Host "[1/4] Verification de Node.js... OK ($nodeVersion)" -ForegroundColor Green
} catch {
    Write-Host "ERREUR: Node.js n'est pas installé ou n'est pas dans le PATH" -ForegroundColor Red
    Write-Host "Téléchargez Node.js depuis https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "Appuyez sur Entrée pour quitter"
    exit 1
}

Write-Host ""

# Vérifier si node_modules existe
if (-not (Test-Path "node_modules")) {
    Write-Host "[2/4] Installation des dependances..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERREUR: Impossible d'installer les dependances" -ForegroundColor Red
        Read-Host "Appuyez sur Entrée pour quitter"
        exit 1
    }
    Write-Host "Installation terminée!" -ForegroundColor Green
} else {
    Write-Host "[2/4] Dependances deja installees" -ForegroundColor Green
}

Write-Host ""

# Vérifier si .env existe
if (-not (Test-Path ".env")) {
    Write-Host "[3/4] Creation du fichier .env..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"

    Write-Host ""
    Write-Host "ATTENTION: Veuillez editer le fichier .env pour configurer:" -ForegroundColor Yellow
    Write-Host "  - PORT: Le port du serveur (defaut: 3000)" -ForegroundColor White
    Write-Host "  - CLAUDE_DIR: Le chemin vers votre dossier .claude" -ForegroundColor White
    Write-Host "    Exemple: C:\Users\VotreNom\.claude" -ForegroundColor White
    Write-Host "  - AUTH_TOKEN: Un token de securite pour l'API" -ForegroundColor White
    Write-Host ""

    $response = Read-Host "Voulez-vous ouvrir le fichier .env maintenant? (O/N)"
    if ($response -eq "O" -or $response -eq "o") {
        notepad .env
    }
} else {
    Write-Host "[3/4] Fichier .env existe deja" -ForegroundColor Green
}

Write-Host ""
Write-Host "[4/4] Demarrage du serveur..." -ForegroundColor Yellow
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Le serveur va demarrer sur http://localhost:3000" -ForegroundColor Green
Write-Host "Appuyez sur Ctrl+C pour arreter le serveur" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Démarrer le serveur
node backend/server.js
