# Use Nodejs image base
FROM node:24-slim

# Set the working directory inside the container
WORKDIR /app

# Memory default
ENV MAX_PROCESS_RAM_MB=8192

# Install all dependencies
ENV DEBIAN_FRONTEND=noninteractive
# Install Docker CLI from Docker's official repository (newer version with API 1.44+ support)
# This is required for API 1.44+ compatibility with newer Docker daemons
RUN apt update && apt install -y --no-install-recommends \
    # zstd for faster apt package compression (faster than gzip)
    zstd \
    # Base dependencies for Docker repo setup
    curl \
    ca-certificates \
    gnupg \
    lsb-release \
    # WireGuard for VPN connections
    wireguard wireguard-tools \
    # Networking tools
    iproute2 dnsutils iputils-ping iptables \
    # wg-quick dependencies
    procps \
    # Git
    git \
    # ncat
    netcat-openbsd \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && docker --version || (echo "ERROR: Failed to install docker-ce-cli. Build cannot continue." && exit 1) \
    # Cleanup cache for image size reduction
    && apt clean && rm -rf /var/lib/apt/lists/*

# Install resolvconf separately (postinstall will fail, we work around it)
RUN apt update \
    && (apt install -y --no-install-recommends resolvconf || true) \
    && mkdir -p /var/lib/dpkg/info \
    && echo '#!/bin/sh\nexit 0' > /var/lib/dpkg/info/resolvconf.postinst \
    && chmod +x /var/lib/dpkg/info/resolvconf.postinst \
    && (dpkg --configure resolvconf || true) \
    && apt clean && rm -rf /var/lib/apt/lists/*

# Configure git
RUN git config --global --add safe.directory /app

# Copy package management files
COPY package*.json ./

# Install dependencies, data files from maxmind and ip2location are downloaded later and not during build
RUN npm config set update-notifier false
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Cachebuster, used in local development to force rebuilds
ARG CACHEBUST=1
RUN echo "CACHEBUST=$CACHEBUST"

# Copy application code
COPY app.js ./
COPY modules ./modules
COPY routes ./routes

# Expose the port the app runs on
EXPOSE 3000

# Serve the app
CMD ["node", "--trace-gc", "app.js"]

# Healthcheck call, expect 200. Note that due to maxmind boot updates we need a long start period
HEALTHCHECK --interval=10s --timeout=10s --start-period=600s --retries=3 CMD curl -f http://localhost:3000/ || exit 1
