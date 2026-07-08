FROM node:22-slim
LABEL io.modelcontextprotocol.server.name="io.github.kuyazee/artifacts"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
VOLUME /data
CMD ["node", "server.js"]
