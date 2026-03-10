FROM node:20-alpine
WORKDIR /app
RUN adduser -u 1000 -G users -s /bin/sh -D appuser
COPY package*.json ./
RUN npm install
COPY server.js ./
USER appuser
ENV PORT=3456
EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3456/health || exit 1
CMD ["node", "server.js"]