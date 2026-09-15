import { Stats } from "../api/client";

const STATUS_ORDER = ["QUEUED", "PROCESSING", "RETRYING", "COMPLETED", "DEAD_LETTERED", "FAILED"];

export default function Overview({ stats }: { stats: Stats }) {
  const maxCount = Math.max(1, ...Object.values(stats.byStatus));

  return (
    <section className="overview">
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-value">{stats.totalJobs}</div>
          <div className="stat-label">Total Jobs</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.totalReplays}</div>
          <div className="stat-label">Total Replays</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.totalAttempts}</div>
          <div className="stat-label">Total Attempts</div>
        </div>
      </div>

      <div className="status-distribution">
        {STATUS_ORDER.map((status) => {
          const count = stats.byStatus[status] ?? 0;
          const widthPct = (count / maxCount) * 100;
          return (
            <div className="status-row" key={status}>
              <span className="status-row-label">{status}</span>
              <div className="status-bar-track">
                <div className="status-bar-fill" style={{ width: `${widthPct}%` }} />
              </div>
              <span className="status-row-count">{count}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}