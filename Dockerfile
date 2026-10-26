FROM node:latest

WORKDIR /hwidx

COPY src/package*.json ./
RUN npm install --production

COPY src/ .
COPY hwidx-entrypoint.sh /usr/local/bin/hwidx-entrypoint.sh

# We don't copy the config or cache directories (for safety), but create them here to be mounted later.
# The router clones the dataset into config itself, as the unprivileged 'node' user (see hwidx-entrypoint.sh).
RUN mkdir config cache && chown node:node config cache && chmod +x /usr/local/bin/hwidx-entrypoint.sh

ENTRYPOINT ["hwidx-entrypoint.sh"]
