FROM node:22-alpine

# `ip` for the extra printer addresses; see docker-entrypoint.sh.
RUN apk add --no-cache iproute2

WORKDIR /app

# No dependencies to install - that is deliberate, and it keeps this layer
# empty and the image small.
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY ui ./ui
COPY devices.example.json ./devices.example.json
COPY devices.docker.json ./devices.docker.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/bin/escpos-emu.js

# The UI and control API.
EXPOSE 7070
# The printers themselves.
EXPOSE 9100 9101 9102 9103

# Each printer on its own published port, so `docker run` works with nothing
# mounted. The compose file mounts devices.json over this for the case the tool
# is really for: several printers on their own addresses.
ENV ESCPOS_CONFIG=/app/devices.docker.json

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--config", "/app/devices.docker.json"]
