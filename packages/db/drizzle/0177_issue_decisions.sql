CREATE TABLE "issue_decision" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"summary" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_decision_kind_check" CHECK ("issue_decision"."kind" IN ('approval', 'owner_task')),
	CONSTRAINT "issue_decision_outcome_check" CHECK (("issue_decision"."kind" = 'approval' AND "issue_decision"."outcome" IN ('approved', 'rejected')) OR ("issue_decision"."kind" = 'owner_task' AND "issue_decision"."outcome" = 'done'))
);
--> statement-breakpoint
CREATE TABLE "issue_decision_request" (
	"issue_id" integer PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by_user_id" text,
	"requested_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_decision_request_kind_check" CHECK ("issue_decision_request"."kind" IN ('approval', 'owner_task'))
);
--> statement-breakpoint
ALTER TABLE "issue_decision" ADD CONSTRAINT "issue_decision_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_decision" ADD CONSTRAINT "issue_decision_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_decision_request" ADD CONSTRAINT "issue_decision_request_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_decision_request" ADD CONSTRAINT "issue_decision_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_decision_request" ADD CONSTRAINT "issue_decision_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_decision_issue_idx" ON "issue_decision" USING btree ("issue_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "issue_decision_request_user_idx" ON "issue_decision_request" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE TRIGGER issue_decision_request_rev AFTER INSERT OR UPDATE OR DELETE ON issue_decision_request FOR EACH ROW EXECUTE FUNCTION rev_issue_child('issue_id', 'detail');
--> statement-breakpoint
CREATE TRIGGER issue_decision_rev AFTER INSERT OR UPDATE OR DELETE ON issue_decision FOR EACH ROW EXECUTE FUNCTION rev_issue_child('issue_id', 'detail');
