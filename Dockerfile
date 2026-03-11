FROM node:20-slim

# Debian (glibc) é necessário — LibreOffice não funciona corretamente em Alpine (musl libc)
RUN apt-get update && apt-get install -y \
    libreoffice-writer \
    fonts-liberation \
    fonts-dejavu-core \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 3333
CMD ["node", "server.js"]
