#!/bin/bash
# ========================================================
# ClaudeCode_Remote - Launcher Script (Linux/macOS)
# ========================================================
# Script unifie qui lance le serveur + tunnel Cloudflare
# et ouvre automatiquement une page web avec QR code
# ========================================================

set -e

# Couleurs pour l'affichage
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Variables globales
SERVER_PID=""
TUNNEL_PID=""
CLOUDFLARED_LOG="/tmp/cloudflared_$RANDOM.log"
TUNNEL_URL=""

# Fonction de nettoyage
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 Arrêt en cours...${NC}"

    # Arrêter cloudflared
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        kill "$TUNNEL_PID" 2>/dev/null || true
        echo -e "${GRAY}  ✓ Tunnel Cloudflare arrêté${NC}"
    fi

    # Arrêter le serveur Node
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        echo -e "${GRAY}  ✓ Serveur Node.js arrêté${NC}"
    fi

    # Nettoyer les processus orphelins
    pkill -f "node backend/server.js" 2>/dev/null || true
    pkill -f "cloudflared tunnel" 2>/dev/null || true

    # Supprimer le fichier de log
    [ -f "$CLOUDFLARED_LOG" ] && rm -f "$CLOUDFLARED_LOG"

    echo ""
    echo -e "${GREEN}✅ Arrêt terminé avec succès${NC}"
    echo ""
    exit 0
}

# Capturer Ctrl+C et autres signaux
trap cleanup EXIT INT TERM

# Nettoyer l'écran
clear

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                                                            ║${NC}"
echo -e "${CYAN}║           ClaudeCode_Remote - Launcher                      ║${NC}"
echo -e "${CYAN}║                                                            ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================================
# Étape 0 : Demander le PIN de sécurité
# ========================================================

echo -e "${YELLOW}[0/3] Configuration de la sécurité...${NC}"
echo ""

# Demander le PIN
while true; do
    read -s -p "Entrez un PIN à 6 chiffres pour sécuriser l'accès: " pin
    echo ""
    if [[ "$pin" =~ ^[0-9]{6}$ ]]; then
        break
    else
        echo -e "${RED}  Le PIN doit contenir exactement 6 chiffres${NC}"
    fi
done

echo -e "${GREEN}✅ PIN configuré${NC}"
echo ""

# Exporter le PIN pour le serveur
export CLAUDECODE_PIN="$pin"

# ========================================================
# Étape 1 : Démarrer le serveur Node.js
# ========================================================

echo -e "${YELLOW}[1/3] Démarrage du serveur...${NC}"

# Démarrer le serveur en arrière-plan
node backend/server.js > /dev/null 2>&1 &
SERVER_PID=$!

# Attendre que le serveur démarre
sleep 3

# Vérifier que le serveur est bien démarré
if curl -s -f http://localhost:3000/api/health > /dev/null; then
    echo -e "${GREEN}✅ Serveur démarré avec succès${NC}"
else
    echo -e "${RED}❌ Erreur : Le serveur n'a pas pu démarrer${NC}"
    exit 1
fi

echo ""

# ========================================================
# Étape 2 : Créer le tunnel Cloudflare
# ========================================================

echo -e "${YELLOW}⏳ Création du tunnel Cloudflare...${NC}"

# Vérifier que cloudflared est installé
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}❌ Erreur : cloudflared n'est pas installé${NC}"
    echo -e "${YELLOW}   Installez-le depuis : https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation${NC}"
    exit 1
fi

# Démarrer cloudflared en mode silencieux
cloudflared tunnel --url http://localhost:3000 > "$CLOUDFLARED_LOG" 2>&1 &
TUNNEL_PID=$!

# Attendre et extraire l'URL du tunnel
attempts=0
max_attempts=30

while [ -z "$TUNNEL_URL" ] && [ $attempts -lt $max_attempts ]; do
    sleep 1
    attempts=$((attempts + 1))

    if [ -f "$CLOUDFLARED_LOG" ]; then
        # Extraire l'URL du tunnel (format : https://xxx.trycloudflare.com)
        TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | head -1)
    fi

    # Animation simple
    if [ $((attempts % 3)) -eq 0 ]; then
        echo -n "."
    fi
done

echo "" # Nouvelle ligne après les points

if [ -z "$TUNNEL_URL" ]; then
    echo -e "${RED}❌ Erreur : Le tunnel n'a pas pu être créé${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Tunnel créé avec succès${NC}"
echo ""

# ========================================================
# Étape 3 : Ouvrir la page launcher avec QR code
# ========================================================

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                            ║${NC}"
echo -e "${GREEN}║                  ✅  TOUT EST PRÊT !  ✅                   ║${NC}"
echo -e "${GREEN}║                                                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}🌐 URL du tunnel : ${NC}$TUNNEL_URL"
echo ""
echo -e "${CYAN}🔐 PIN de sécurité : ${NC}$pin"
echo ""
echo -e "${YELLOW}[3/3] Ouverture de la page launcher...${NC}"

# Construire l'URL de la page launcher
LAUNCHER_URL="http://localhost:3000/launcher.html?url=$(printf %s "$TUNNEL_URL" | jq -sRr @uri 2>/dev/null || python3 -c "import urllib.parse; print(urllib.parse.quote('$TUNNEL_URL'))" 2>/dev/null || echo "$TUNNEL_URL")"

# Ouvrir la page dans le navigateur par défaut
if command -v xdg-open &> /dev/null; then
    xdg-open "$LAUNCHER_URL" &> /dev/null
elif command -v open &> /dev/null; then
    open "$LAUNCHER_URL" &> /dev/null
else
    echo -e "${YELLOW}   Ouvrez manuellement : $LAUNCHER_URL${NC}"
fi

# Copier l'URL dans le presse-papier si possible
if command -v xclip &> /dev/null; then
    echo "$TUNNEL_URL" | xclip -selection clipboard 2>/dev/null && echo -e "${GREEN}📋 URL copiée dans le presse-papier${NC}"
elif command -v pbcopy &> /dev/null; then
    echo "$TUNNEL_URL" | pbcopy && echo -e "${GREEN}📋 URL copiée dans le presse-papier${NC}"
fi

echo ""
echo -e "${GRAY}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${YELLOW}💡${NC} Utilisez la page web pour partager le lien ou scanner le QR code"
echo -e "  ${YELLOW}🔐${NC} Les utilisateurs devront entrer le PIN : $pin"
echo ""
echo -e "  ${RED}🛑${NC} Pour arrêter : Appuyez sur Ctrl+C ou utilisez le bouton dans l'interface web"
echo ""
echo -e "${GRAY}════════════════════════════════════════════════════════════${NC}"
echo ""

# ========================================================
# Étape 4 : Garder le script actif
# ========================================================

# Boucle infinie pour garder le script actif
while true; do
    sleep 1

    # Vérifier si cloudflared est toujours actif
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo ""
        echo -e "${YELLOW}⚠️  Le tunnel Cloudflare s'est arrêté de manière inattendue${NC}"
        break
    fi

    # Vérifier si le serveur est toujours actif
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo ""
        echo -e "${YELLOW}⚠️  Le serveur Node.js s'est arrêté${NC}"
        break
    fi
done
