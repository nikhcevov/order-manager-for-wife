# syntax=docker/dockerfile:1

# The frontend is still built by Vite; the API runs on Python.
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build -w apps/web

FROM python:3.13-slim AS python
ARG UV_VERSION=0.13.7
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
RUN pip install --no-cache-dir "uv==${UV_VERSION}"
WORKDIR /app
COPY apps/api-py/pyproject.toml apps/api-py/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}" PYTHONPATH=/app/apps/api-py

# The publishing smoke and existing Unraid media bind mount both expect UID 1000.
RUN useradd --uid 1000 --user-group --create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=python /app/.venv /app/.venv
COPY apps/api-py/shop /app/apps/api-py/shop
COPY apps/api/migrations /app/apps/api/migrations
COPY --from=web /web/apps/web/dist /app/apps/web/dist
RUN mkdir -p /app/var/media && chown -R app:app /app/var /app/apps/api-py

USER app
EXPOSE 3000
WORKDIR /app/apps/api-py
CMD ["python", "-m", "shop.server"]
