import { useState } from "react";
import { ApiError, JobDetail as JobDetailType, replayJob } from "../api/client";
import { getStoredApiKey, setStoredApiKey, clearStoredApiKey } from "../api/apiKey";
import StatusBadge from "./StatusBadge";

export default function JobDetail({
  job,
  onBack,
  onReplayed,
}: {
  job: JobDetailType;
  onBack: () => void;
  onReplayed: () => void;
}) {
  const [replaying, setReplaying] = useState(false);
  const [replayMessage, setReplayMessage] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Phase 16: replay is a state-changing, operator-only action gated
  // behind the API's requireApiKey middleware. If no operator key is
  // stored yet for this tab, ask for one before attempting the
  // request -- the simplest UI that still keeps the key out of the
  // bundle and out of any component's persistent state beyond this
  // browser tab (see api/apiKey.ts). A 401 response (missing/incorrect
  // key) clears whatever was stored and asks the operator to retry,
  // rather than silently failing with no explanation.
  async function handleReplay() {
    let apiKey = getStoredApiKey();
    if (!apiKey) {
      const entered = window.prompt("Enter operator API key to replay this job:");
      if (!entered) return;
      apiKey = entered;
      setStoredApiKey(apiKey);
    }

    setReplaying(true);
    setReplayMessage(null);
    setReplayError(null);
    try {
      const result = await replayJob(job.id);
      setReplayMessage(`Replay queued (replay #${result.replayCount}).`);
      onReplayed();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          clearStoredApiKey();
          setReplayError("Unauthorized -- incorrect operator key. Try Replay again to re-enter it.");
        } else if (err.status === 409) setReplayError("Job is no longer in a replayable state.");
        else if (err.status === 404) setReplayError("Job not found.");
        else setReplayError("Replay failed.");
      } else {
        setReplayError("Replay failed (network error).");
      }
    } finally {
      setReplaying(false);
    }
  }

  const isDeadLettered = job.status === "DEAD_LETTERED";

  return (
    <section className="job-detail">
      <button onClick={onBack} className="back-button">
        &larr; Back to list
      </button>

      <h2>
        Job {job.id} <StatusBadge status={job.status} />
      </h2>

      <dl className="job-fields">
        <dt>Type</dt>
        <dd>{job.type}</dd>
        <dt>Attempt Count (current cycle)</dt>
        <dd>
          {job.attempt_count} / {job.max_attempts}
        </dd>
        <dt>Created</dt>
        <dd>{new Date(job.created_at).toLocaleString()}</dd>
        <dt>Updated</dt>
        <dd>{new Date(job.updated_at).toLocaleString()}</dd>
      </dl>

      <div className="lifetime-fields">
        <h3>Lifetime Aggregate Activity</h3>
        <p className="hint">
          Aggregate lifetime counters only -- this project does not maintain a per-attempt history table, so
          individual past attempts are not separately recorded.
        </p>
        <dl className="job-fields">
          <dt>Total Attempts (all replay cycles)</dt>
          <dd>{job.total_attempt_count}</dd>
          <dt>Replay Count</dt>
          <dd>{job.replay_count}</dd>
        </dl>
      </div>

      {(job.last_dead_lettered_at || job.status === "DEAD_LETTERED") && (
        <div className="dead-letter-info">
          <h3>Dead-Letter Information</h3>
          <dl className="job-fields">
            <dt>Last Dead-Lettered At</dt>
            <dd>{job.last_dead_lettered_at ? new Date(job.last_dead_lettered_at).toLocaleString() : "N/A"}</dd>
            <dt>Last Dead-Letter Reason</dt>
            <dd>{job.last_dead_letter_reason ?? "N/A"}</dd>
            <dt>Last Error</dt>
            <dd>{job.last_error ?? "N/A"}</dd>
          </dl>
        </div>
      )}

      {isDeadLettered && (
        <div className="replay-action">
          <button onClick={handleReplay} disabled={replaying}>
            {replaying ? "Replaying..." : "Replay Job"}
          </button>
          {replayMessage && <p className="replay-success">{replayMessage}</p>}
          {replayError && <p className="replay-error">{replayError}</p>}
        </div>
      )}
    </section>
  );
}