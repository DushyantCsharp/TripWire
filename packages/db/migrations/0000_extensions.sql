-- pgvector must exist before 0001 creates incidents.embedding. drizzle-kit doesn't emit extensions.
CREATE EXTENSION IF NOT EXISTS vector;
