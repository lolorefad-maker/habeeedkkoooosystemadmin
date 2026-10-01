CREATE TABLE "controllers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"station_id" uuid,
	"status" text DEFAULT 'ready' NOT NULL,
	"charging_since" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "controllers" ADD CONSTRAINT "controllers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controllers_branch_number_uq" ON "controllers" USING btree ("branch_id","number");