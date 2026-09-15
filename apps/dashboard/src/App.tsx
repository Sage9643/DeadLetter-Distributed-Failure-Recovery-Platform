import { useCallback, useEffect, useState } from "react";
import { getStats, getRecentJobs, getJob, Stats, RecentJob, JobDetail as JobDetailType, ApiError } from "./api/client";
import Overview from "./components/Overview";
import JobList from "./components/JobList";
import JobDetail from "./components/JobDetail";
import { useJobEvents } from "./ws/useJobEvents";

const REFRESH_INTERVAL_MS = 15000;

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<RecentJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetailType | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { lastEvent, connectionState } = useJobEvents();

  const refreshOverview = useCallback(async () => {
    try {
      const [statsResult, jobsResult] = await Promise.all([getStats(), getRecentJobs()]);
      setStats(statsResult);
      setJobs(jobsResult.jobs);
      setError(null);
    } catch {
      setError("Unable to load dashboard data. Retrying...");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSelectedJob = useCallback(async (id: string) => {
    try {
      const job = await getJob(id);
      setSelectedJob(job);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setSelectedJob(null);
        setSelectedJobId(null);
      }
    }
  }, []);

  useEffect(() => {
    refreshOverview();
    const interval = setInterval(refreshOverview, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshOverview]);

  useEffect(() => {
    if (selectedJobId) refreshSelectedJob(selectedJobId);
  }, [selectedJobId, refreshSelectedJob]);

  // WebSocket events are notifications only -- on any job.updated event,
  // refetch the authoritative REST data rather than trusting the event
  // payload itself.
  useEffect(() => {
    if (!lastEvent) return;
    refreshOverview();
    if (selectedJobId && lastEvent.jobId === selectedJobId) {
      refreshSelectedJob(selectedJobId);
    }
  }, [lastEvent, refreshOverview, refreshSelectedJob, selectedJobId]);

  function handleSelect(id: string) {
    setSelectedJobId(id);
  }

  function handleBack() {
    setSelectedJobId(null);
    setSelectedJob(null);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>DeadLetter Operational Dashboard</h1>
        <span className={`connection-indicator connection-${connectionState}`}>
          {connectionState === "open" ? "Live" : connectionState === "connecting" ? "Connecting..." : "Offline (REST fallback active)"}
        </span>
      </header>

      {error && <p className="global-error">{error}</p>}
      {loading && <p className="loading-state">Loading...</p>}

      {!loading && !selectedJobId && stats && (
        <>
          <Overview stats={stats} />
          <h2>Recent Jobs</h2>
          <JobList jobs={jobs} onSelect={handleSelect} />
        </>
      )}

      {selectedJobId && selectedJob && (
        <JobDetail job={selectedJob} onBack={handleBack} onReplayed={() => refreshSelectedJob(selectedJobId)} />
      )}

      {selectedJobId && !selectedJob && <p className="loading-state">Loading job...</p>}
    </div>
  );
}