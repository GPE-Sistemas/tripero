-- Migración 005: Agrega campos de detección de sensor de ignición por device
-- has_ignition: true si alguna vez llegó ignition=true (nunca vuelve a false)
-- last_ignition_seen_at: última vez que llegó ignition=true
-- Si Date.now() - last_ignition_seen_at > IGNITION_EXPIRY_DAYS → motion-only

ALTER TABLE tracker_state
  ADD COLUMN IF NOT EXISTS has_ignition BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_ignition_seen_at TIMESTAMPTZ NULL;
