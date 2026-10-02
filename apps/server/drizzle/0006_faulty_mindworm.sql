CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"earned_session_id" uuid NOT NULL,
	"earned_day" text NOT NULL,
	"minutes" integer NOT NULL,
	"played_minutes" integer NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"used_at" timestamp with time zone,
	"used_session_id" uuid,
	"used_bill_id" uuid,
	"notified_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rewards_earned_session_uq" ON "rewards" USING btree ("earned_session_id");--> statement-breakpoint
CREATE INDEX "rewards_branch_status_idx" ON "rewards" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "rewards_customer_idx" ON "rewards" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_phone_uq" ON "customers" USING btree ("org_id","phone");