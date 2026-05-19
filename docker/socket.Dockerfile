FROM node:22-alpine@sha256:f598378b5240225e6beab68fa9f356db1fb8efe55173e6d4d8153113bb8f333c

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.json ./
COPY apps/socket ./apps/socket
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chat/types build
RUN pnpm --filter @chat/socket build

EXPOSE 3001

CMD ["pnpm", "--filter", "@chat/socket", "start"]
