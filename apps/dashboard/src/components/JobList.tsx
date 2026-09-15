import { RecentJob } from "../api/client";
import StatusBadge from "./StatusBadge";

export default function JobList({ jobs, onSelect }: { jobs: RecentJob[]; onSelect: (id: string) => void }) {
  if (jobs.length === 0) {
    return <p className="empty-state">No jobs yet.</p>;
  }

  return (
    <table className="job-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Created</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id} className="job-row" onClick={() => onSelect(job.id)}>
            <td className="job-id">{job.id.slice(0, 8)}...</td>
            <td>{job.type}</td>
            <td>
              <StatusBadge status={job.status} />
            </td>
            <td>
              {job.attempt_count}/{job.max_attempts}
            </td>
            <td>{new Date(job.created_at).toLocaleString()}</td>
            <td>{new Date(job.updated_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}