#!/bin/bash

set -Eeuo pipefail

PROJECT="$HOME/Documents/Bellwake/backend"
SOURCE="$PROJECT/"

SSH_TARGET="remote@89.223.81.244"
REMOTE_DIR="/var/www/bellwake.oncocentre.ru/backend"
DEST="$SSH_TARGET:$REMOTE_DIR/"
SSH_PORT=58080
PM2_APP="bellwake-api"
REMOTE_NODE_SETUP='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"'

echo
echo "$(date '+%H:%M:%S') → Bellwake Backend deploy"

cd "$PROJECT"

echo
echo "$(date '+%H:%M:%S') → uploading backend"

rsync -az --delete \
	-e "ssh -p $SSH_PORT" \
	--no-owner \
	--no-group \
	--chmod='Dg+s,Dg+w,Fg+w' \
	--exclude '.DS_Store' \
	--exclude '.env' \
	--exclude 'node_modules/' \
	--exclude 'npm-debug.log*' \
	--exclude 'coverage/' \
	"$SOURCE" \
	"$DEST"

echo
echo "$(date '+%H:%M:%S') ✓ upload complete"
echo "$(date '+%H:%M:%S') → installing production dependencies"

ssh -p "$SSH_PORT" "$SSH_TARGET" \
	"$REMOTE_NODE_SETUP && cd '$REMOTE_DIR' && npm ci --omit=dev && pm2 restart '$PM2_APP' --update-env && pm2 show '$PM2_APP'"

echo
echo "$(date '+%H:%M:%S') ✓ dependencies installed"
echo "$(date '+%H:%M:%S') ✓ deploy complete"
