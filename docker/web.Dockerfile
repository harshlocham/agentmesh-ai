FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chat/types build
RUN pnpm --filter @chat/services build
RUN pnpm --filter @chat/web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@chat/web", "start"]
