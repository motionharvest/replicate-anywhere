FROM node:lts-alpine AS builder
WORKDIR /app

ENV REPLICATE_API_TOKEN=${REPLICATE_API_TOKEN}

# Copy package files
COPY package*.json ./
# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code and build configuration
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Production stage
FROM node:lts-alpine AS production
WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

# Expose port (adjust if your app uses a different port)
EXPOSE 3000

CMD ["node", "build/index.js"]
