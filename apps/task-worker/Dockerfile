FROM node:20-alpine
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.json ./
COPY apps/task-worker ./apps/task-worker
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm run clean:artifacts
RUN pnpm --filter @chat/types build
RUN pnpm --filter @chat/db build
RUN pnpm --filter @chat/services build
RUN pnpm --filter @chat/task-worker build

EXPOSE 4444
CMD ["pnpm", "--filter", "@chat/task-worker", "start"]
