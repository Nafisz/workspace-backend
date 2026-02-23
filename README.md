# NovaX Backend

Backend service for NovaX, built with Node.js, Fastify, and TypeScript.

## Docker Setup (Recommended)

To run the backend using Docker, ensure you have Docker and Docker Compose installed.

1.  **Configure Environment:**
    Copy the example environment file and configure your secrets.
    ```bash
    cp .env.example .env
    ```
    Edit `.env` and set your `ANTHROPIC_API_KEY` and `API_KEY`.

2.  **Start the Service:**
    ```bash
    docker-compose up -d
    ```
    This will start the backend on port 8080 (or as configured in `.env`).

3.  **View Logs:**
    ```bash
    docker-compose logs -f
    ```

4.  **Stop the Service:**
    ```bash
    docker-compose down
    ```

## Local Development

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Run in Development Mode:**
    ```bash
    npm run dev
    ```

3.  **Build and Run:**
    ```bash
    npm run build
    npm start
    ```

## Project Structure

- `src/` - Source code
  - `routes/` - API endpoints
  - `services/` - Business logic (Claude, MCP, etc.)
  - `db/` - Database client and schema
  - `ws/` - WebSocket handlers
- `data/` - Persistent data (SQLite DB, uploads) - Mounted as volume in Docker
