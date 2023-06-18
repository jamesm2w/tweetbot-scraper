# syntax=docker/dockerfile:1
FROM node:20-alpine
FROM ghcr.io/puppeteer/puppeteer:20.5.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production
# USER root
# RUN addgroup app && adduser -S -G app app 

WORKDIR /home/pptruser/app

COPY --chown=pptruser:node ["package.json", "package-lock.json", "./"]
# COPY ["package.json", "package-lock.json", "./"]
RUN npm install --production
COPY --chown=pptruser:node . .
CMD ["node", "index.js"]