# The Node self-host (`npm run serve:node`) as an image. Build from the repo root, since the app
# resolves @tinytars/frame through the npm workspace:
#   docker build -f apps/lexitar/Dockerfile -t lexitar .
#   docker run -p 8788:8788 -v lexi-data:/data -e SESSION_SECRET=... -e STORE_PREFIX=prod lexitar
FROM node:22-slim
WORKDIR /lexi
COPY . .
RUN npm ci && npm run build --workspace apps/lexitar
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /lexi/apps/lexitar
ENV LEXI_DATA_DIR=/data PORT=8788
VOLUME /data
EXPOSE 8788
CMD ["node", "--import", "tsx", "server/node.ts"]
