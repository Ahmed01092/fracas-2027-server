FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs index.html ./
COPY data ./data
COPY src ./src
COPY assets ./assets
ENV HOST=0.0.0.0
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.mjs"]
