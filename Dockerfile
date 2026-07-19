FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run typecheck

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_MODE=replay
ENV DEMO_MODE=true
ENV THEO_MODE=market_baseline
ENV TRADING_MODE=paper
ENV ENABLE_REAL_EXECUTION=false
ENV ENABLE_WALLET_OPERATIONS=false
ENV ENABLE_TXODDS_ACTIVATION=false
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/data/samples ./data/samples
EXPOSE 8787
CMD ["npm", "run", "start"]
