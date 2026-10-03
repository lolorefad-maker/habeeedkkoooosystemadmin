CREATE TABLE "cash_withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"business_day" text NOT NULL,
	"amount" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"void_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_withdrawals" ADD CONSTRAINT "cash_withdrawals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_withdrawals_shift_idx" ON "cash_withdrawals" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "cash_withdrawals_branch_day_idx" ON "cash_withdrawals" USING btree ("branch_id","business_day");