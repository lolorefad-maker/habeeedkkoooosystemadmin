CREATE TABLE "day_carries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"business_day" text NOT NULL,
	"time" integer NOT NULL,
	"items" integer NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "day_carries" ADD CONSTRAINT "day_carries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "day_carries_branch_day_idx" ON "day_carries" USING btree ("branch_id","business_day");--> statement-breakpoint
CREATE INDEX "day_carries_session_idx" ON "day_carries" USING btree ("session_id");