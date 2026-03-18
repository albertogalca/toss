#!/bin/sh
RELAY_URL="${TOSS_RELAY_URL:-ws://localhost:3001}"
echo "window.TOSS_RELAY_URL = \"$RELAY_URL\";" > /usr/share/nginx/html/config.js
