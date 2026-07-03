#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Home Inventory on 0.0.0.0:8099"
mkdir -p /data/images
exec python3 /app/server.py
