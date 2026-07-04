ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.13-alpine3.21
FROM $BUILD_FROM

# Pillow needs jpeg/zlib at build & runtime on Alpine.
RUN apk add --no-cache jpeg zlib

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY server.py db.py normalize.py ha_client.py /app/
COPY www /app/www
COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL \
  io.hass.type="addon" \
  io.hass.name="Home Inventory" \
  io.hass.version="2.0.1"

CMD [ "/run.sh" ]
