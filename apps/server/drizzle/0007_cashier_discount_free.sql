-- The cashier may give any discount without the manager's PIN (the owner can lower the limit in Settings).
UPDATE "branches"
SET "settings" = jsonb_set("settings", '{checkout,maxCashierDiscountPercent}', '100')
WHERE "settings" -> 'checkout' IS NOT NULL;
