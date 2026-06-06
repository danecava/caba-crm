# Caba Life CRM — zero-dependency, runs on Node 22 built-ins.
FROM node:22-alpine
WORKDIR /app
COPY . .
# Persist SQLite to a mounted volume in production (see README).
ENV DB_PATH=/app/data/caba-crm.db
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
