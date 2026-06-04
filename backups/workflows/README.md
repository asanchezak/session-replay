# Workflow backups

Full JSON exports of recorded workflows from the AWS backend, kept so a workflow can
be **restored if the AWS DB is lost or a workflow is deleted/edited**.

## File format
Each `*.json` is:
```jsonc
{
  "_backup": { "exported_at", "source", "workflow_id", "note" },
  "workflow": { ...GET /v1/workflows/{id}... },   // metadata + embedded "steps" (recorded actions)
  "template": { ...GET /v1/workflows/{id}/template... }  // template_data (execution plan template)
}
```

## Make a new backup
```bash
D=https://52-5-45-84.sslip.io ; KEY=<gateway-api-key> ; WF=<workflow-id>
curl -s -H "X-API-Key: $KEY" "$D/v1/workflows/$WF"          > wf.json
curl -s -H "X-API-Key: $KEY" "$D/v1/workflows/$WF/template" > tmpl.json
# combine into one doc (see how the existing files are shaped)
```

## Restore (if needed)
There is no one-click import endpoint today. To restore, re-create the rows in the
backend Postgres from this JSON:
- `workflows` row: from `workflow` (id, name, target_url, status, workflow_type,
  execution_mode, version, config).
- `workflow_steps` rows: from `workflow.steps[]` (step_index, action_type, intent,
  selector_chain, value, methods, success_condition, dom_context).
- the template_data: from `template`.

A small importer script can read this JSON and INSERT the rows (the DB is the
single source of truth — see memory `project_aws_backend_deploy`). Ask and one can
be added under `scripts/`.

## Index
- `0a8404f9-f745-4778-9429-3e06e125c146__linkedin-and-akurey-careers-search.json` —
  "LinkedIn and Akurey Careers Search" (Recruiter, `linkedin.com/talent/home`),
  generic, 317 steps. Recorded 2026-06-04 on Fernanda's host.
