# Build frontend
FROM node:18-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/ ./frontend/
RUN npm install
RUN npm run build -w frontend

# Production image
FROM node:18-alpine
WORKDIR /app

# Backend dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Backend source
COPY backend/ ./backend/

# Built frontend
COPY --from=frontend /app/frontend/dist ./public

WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "src/server.js"]
