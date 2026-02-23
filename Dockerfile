# Stage 1: Install production dependencies
FROM node:22-alpine AS deps
WORKDIR /app
# Install build tools for native modules like better-sqlite3
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Install all dependencies (including devDependencies for tsc)
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Production image
FROM node:22-alpine AS runner
WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy database schema (required by code)
COPY src/db/schema.sql ./src/db/schema.sql

# Create data directory
RUN mkdir -p data/uploads

# Environment variables
ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
