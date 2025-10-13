FROM node:latest

WORKDIR /hwidx

COPY src/package*.json ./
RUN npm install --production

COPY src/ .

# We don't copy the config directory (for safety), but create it instead here to be mounted later.
RUN mkdir config

ENTRYPOINT ["node", "service.js"]