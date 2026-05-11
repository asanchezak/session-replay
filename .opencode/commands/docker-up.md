---
description: Start all Docker services for local development
---
Start the full development environment with Docker Compose.

Run `docker compose up --build` from the project root.
Wait for all services to become healthy before reporting.
Services: api (port 8000), postgres (5432), redis (6379), minio (9000).
