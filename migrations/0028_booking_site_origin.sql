-- Where this CloudMail lives (https://mail.example.com), remembered from the
-- last booking, so links in mail sent later (by an agent, from the cron) point
-- back to the right site.
ALTER TABLE booking_pages ADD COLUMN site_origin TEXT;
