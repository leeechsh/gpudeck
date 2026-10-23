ALTER TABLE reservation_allocations ADD COLUMN first_used_at TEXT;
-- Older releases only recorded reservation-level use. Preserve already-used
-- bookings conservatively because historical per-GPU use cannot be recovered.
UPDATE reservation_allocations
SET first_used_at=(SELECT checked_in_at FROM reservations WHERE id=reservation_id)
WHERE reservation_id IN (SELECT id FROM reservations WHERE checked_in_at IS NOT NULL);
