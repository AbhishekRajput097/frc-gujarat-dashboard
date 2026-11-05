import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __frcDbPool: Pool | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL env var");
  }

  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

export function getDbPool(): Pool {
  if (global.__frcDbPool) return global.__frcDbPool;
  const pool = createPool();
  if (process.env.NODE_ENV !== "production") {
    global.__frcDbPool = pool;
  }
  return pool;
}

