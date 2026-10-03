-- The day is the shift: it ends when the shift is closed by hand (even after midnight), never by itself at 00:00.
UPDATE "branches"
SET "settings" = jsonb_set("settings", '{day,autoCloseDay}', 'false')
WHERE "settings" -> 'day' IS NOT NULL;
