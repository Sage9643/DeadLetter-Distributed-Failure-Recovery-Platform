const STATUS_COLORS: Record<string, string> = {
  QUEUED: "#6b7280",
  PROCESSING: "#2563eb",
  RETRYING: "#d97706",
  COMPLETED: "#16a34a",
  DEAD_LETTERED: "#dc2626",
  FAILED: "#991b1b",
};

export default function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#6b7280";
  return (
    <span className="status-badge" style={{ backgroundColor: color }}>
      {status}
    </span>
  );
}