#!/usr/bin/env bash
# Sourced by the Paloma LaunchAgent entry points. Records a terminal result in
# memory/job-status.json through the shared automation/job_health helper so the
# job watchdog can see these jobs at all (F-066: none of the trio reported, and
# the weeklies could not even exit nonzero).
#
# Usage, after setting SOCIALSOL_ROOT and PALOMA_JOB_NAME:
#   source "$SCRIPT_DIR/job-status.sh"
#   paloma_job_status_trap          # records ok/failed from the exit code
#   PALOMA_JOB_DETAIL="..."         # optional detail for the record

paloma_record_job_status() {
  local job="$1" outcome="$2" detail="${3:-}"
  PALOMA_JOB="$job" PALOMA_OUTCOME="$outcome" PALOMA_DETAIL="$detail" SOCIALSOL_ROOT_DIR="$SOCIALSOL_ROOT" \
    "${PYTHON_BIN:-python3}" - <<'PYHELPER' || echo "[paloma] job_health record failed for ${job}" >&2
import os
import sys

sys.path.insert(0, os.path.join(os.environ["SOCIALSOL_ROOT_DIR"], "automation"))
from job_health import record  # noqa: E402

record(os.environ["PALOMA_JOB"], os.environ["PALOMA_OUTCOME"] == "ok", os.environ.get("PALOMA_DETAIL") or None)
PYHELPER
}

paloma_job_status_on_exit() {
  local code=$?
  if [ "$code" -eq 0 ]; then
    paloma_record_job_status "$PALOMA_JOB_NAME" ok "${PALOMA_JOB_DETAIL:-completed}"
  else
    paloma_record_job_status "$PALOMA_JOB_NAME" failed "exit ${code}: ${PALOMA_JOB_DETAIL:-did not finish}"
  fi
  exit "$code"
}

paloma_job_status_trap() {
  trap paloma_job_status_on_exit EXIT
}
