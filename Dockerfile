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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/bin/escpos-emu.js

# The UI and control API.
EXPOSE 7070
# The printers themselves.
EXPOSE 9100

ENV ESCPOS_CONFIG=/app/devices.json

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--config", "/app/devices.json"]
