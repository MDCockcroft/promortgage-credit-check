// Retention rules from the Operator Agreement with Pro Mortgage (28 Oct 2026), as pure functions so
// mm-maintenance stays thin and the rules are tested without a database:
//   - an application the clean-up expired is deleted 30 days after it expired;
//   - a credit report is deleted 12 months after it was received (the risk band and the enquiry
//     reference stay on the record — purge_report, migration 20261010);
//   - the stored files are copied weekly into the 'file-backups' bucket under a dated folder, and
//     folders older than 30 days are removed.

export const EXPIRED_KEEP_DAYS = 30;
export const REPORT_KEEP_MONTHS = 12;
export const BACKUP_KEEP_DAYS = 30;
export const BACKUP_BUCKET = "file-backups";
/** The buckets whose files are copied weekly (and whose copies a deletion must also remove). */
export const BACKED_UP_BUCKETS = ["id-documents", "credit-reports"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** The same calendar day `months` months earlier (clamped to the end of a shorter month). */
export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

interface ExpiredRow { ref: string; status: string; expired_at: string | null }
interface ReportRow { ref: string; status: string; report_ready_at: string | null; report_purged_at: string | null }

/** Expired applications whose 30 days have run. A row without expired_at is never deleted on a guess. */
export function expiredDue(rows: ExpiredRow[], now: Date): string[] {
  const cutoff = daysBefore(now, EXPIRED_KEEP_DAYS).getTime();
  return rows
    .filter((r) => r.status === "expired" && r.expired_at && new Date(r.expired_at).getTime() < cutoff)
    .map((r) => r.ref);
}

/** Reports received more than 12 months ago that have not been purged yet. */
export function reportsDue(rows: ReportRow[], now: Date): string[] {
  const cutoff = monthsBefore(now, REPORT_KEEP_MONTHS).getTime();
  return rows
    .filter((r) => r.status === "report_ready" && !r.report_purged_at && r.report_ready_at &&
      new Date(r.report_ready_at).getTime() < cutoff)
    .map((r) => r.ref);
}

/** The dated folder a weekly copy goes under: YYYY-MM-DD (UTC). */
export function backupFolder(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dated folders older than the keep period. Anything that is not a dated folder is left alone. */
export function foldersToPrune(names: string[], now: Date, keepDays: number = BACKUP_KEEP_DAYS): string[] {
  const cutoff = backupFolder(daysBefore(now, keepDays));
  return names.filter((n) => FOLDER_RE.test(n) && n < cutoff);
}

/** Where a file's copy lives in the backup bucket. */
export function backupPath(folder: string, bucket: string, path: string): string {
  return `${folder}/${bucket}/${path}`;
}
