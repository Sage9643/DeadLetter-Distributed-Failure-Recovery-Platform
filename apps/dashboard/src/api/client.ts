export interface Stats {
  totalJobs: number;
  byStatus: Record<string, number>;
  totalReplays: number;
  totalAttempts: number;
}

export interface RecentJob {
  id: string;
  type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface JobDetail {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  total_attempt_count: number;
  replay_count: number;
  last_dead_lettered_at: string | null;
  last_dead_letter_reason: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error: ${status}`);
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // no JSON body -- leave as null
    }
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export function getStats(): Promise<Stats> {
  return request<Stats>("/api/stats");
}

export function getRecentJobs(): Promise<{ jobs: RecentJob[] }> {
  return request<{ jobs: RecentJob[] }>("/api/jobs");
}

export function getJob(id: string): Promise<JobDetail> {
  return request<JobDetail>(`/api/jobs/${id}`);
}

export function replayJob(id: string): Promise<{ jobId: string; status: string; replayCount: number }> {
  return request(`/api/jobs/${id}/replay`, { method: "POST" });
}