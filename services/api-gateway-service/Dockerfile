FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN apk add --no-cache openssl \
  && mkdir -p /app/certs \
  && openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /app/certs/key.pem \
    -out /app/certs/cert.pem \
    -days 365 \
    -subj "/CN=localhost"

ENV TLS_KEY_PATH=/app/certs/key.pem
ENV TLS_CERT_PATH=/app/certs/cert.pem

EXPOSE 3000

CMD ["npm", "start"]
