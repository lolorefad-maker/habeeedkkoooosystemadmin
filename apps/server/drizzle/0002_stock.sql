ALTER TABLE "products" ADD COLUMN "pack_size" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "cartons" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "pack_size" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "unit_price" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "note" text;