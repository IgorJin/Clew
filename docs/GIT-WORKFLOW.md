# Git workflow for agent worktrees

Clew runs agents in isolated Git worktrees. Each run records the immutable base commit, branch, and worktree location. The task header can inspect the exact run, open that worktree in Cursor or VS Code, or copy its path.

## Review changes

Select the run in the task header and use `Changes +N −M`:

- the main button opens the persisted worktree in the configured editor, then Cursor, then VS Code;
- `View diff` reads committed, staged, unstaged, and untracked changes relative to the run's recorded `base_sha`;
- `Copy worktree path` copies the persisted local path;
- runner-local worktrees are explicitly unavailable from a different Controller host.

The inspection path is read-only. It does not accept a caller-provided workspace and never changes the primary checkout.

## Transfer accepted work

`Complete` records that a verified revision was accepted. It does not merge, cherry-pick, push, pull, or modify the primary checkout.

Choose one explicit transfer operation after review:

```sh
# Merge the agent branch into the current target branch.
git merge ai/TASK-stage

# Or transfer only a selected commit.
git cherry-pick <agent-commit-sha>

# Or push the agent branch and open a pull request in the hosting system.
git push origin ai/TASK-stage
```

Resolve conflicts in the target checkout using the normal repository policy. After the target branch is merged remotely, other default checkouts update through their normal `git pull` workflow.

## Cleanup

Remove a Clew worktree only after its changes have been transferred or intentionally discarded. Dirty or active worktrees are protected by Clew's cleanup checks. A missing worktree remains visible as an explicit unavailable state rather than silently falling back to another directory.
