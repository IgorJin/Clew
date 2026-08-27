CREATE UNIQUE INDEX IF NOT EXISTS runs_task_stage_attempt
ON runs(task_id, stage_id, attempt);
