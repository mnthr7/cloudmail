-- The original header block of inbound mail (capped at 64 KB), so the reader
-- can see who really sent a message: Return-Path, signatures, the servers it
-- passed through. Null on mail that arrived before this, and on mail we send.
ALTER TABLE emails ADD COLUMN raw_headers TEXT;
