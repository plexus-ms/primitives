#!/bin/sh
# Runs after every job, as the runner user (ACTIONS_RUNNER_HOOK_JOB_COMPLETED
# in the instance's unit). Managed by Ansible (github_runner).
#
# The runner removes a job's service containers without their anonymous
# volumes, so a service whose image declares one (postgres, redis, …) leaves
# a volume behind per job. Pruning the unused anonymous volumes here keeps
# them from piling up between the nightly housekeeping runs; a volume that a
# container of a running job holds is in use and stays.
docker volume prune --force || true # a failing hook fails the job
