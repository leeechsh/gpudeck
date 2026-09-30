CREATE TABLE hub_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    concurrent_gpu_limit integer NOT NULL DEFAULT 2 CHECK (concurrent_gpu_limit BETWEEN 1 AND 14)
);
INSERT INTO hub_settings (id) VALUES (true);

-- Serialize account creation with global changes so new accounts cannot inherit
-- a stale default while a bulk update is in flight (including bootstrap/sync).
CREATE FUNCTION inherit_global_gpu_limit() RETURNS trigger AS $$
BEGIN
    SELECT concurrent_gpu_limit INTO NEW.concurrent_gpu_limit
    FROM hub_settings WHERE id = true FOR SHARE;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_global_gpu_limit BEFORE INSERT ON users
FOR EACH ROW EXECUTE FUNCTION inherit_global_gpu_limit();
