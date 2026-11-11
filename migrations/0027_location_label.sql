-- How a booking page's location reads to visitors, in the host's own words
-- ("I'll call your cell"). Null: CloudMail's wording for the location kind.
ALTER TABLE booking_pages ADD COLUMN location_label TEXT;
