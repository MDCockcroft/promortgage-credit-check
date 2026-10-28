import { assertEquals } from "jsr:@std/assert@1";
import {
  BACKUP_KEEP_DAYS, backupFolder, backupPath, EXPIRED_KEEP_DAYS, expiredDue, foldersToPrune, monthsBefore,
  REPORT_KEEP_MONTHS, reportsDue,
} from "./retention.ts";

const NOW = new Date("2026-10-28T02:30:00Z");

Deno.test("the agreed periods", () => {
  assertEquals([EXPIRED_KEEP_DAYS, REPORT_KEEP_MONTHS, BACKUP_KEEP_DAYS], [30, 12, 30]);
});

Deno.test("expired applications: deleted 30 days after they expired, never on a guess", () => {
  const rows = [
    { ref: "PM-OLD1", status: "expired", expired_at: "2026-09-27T00:00:00Z" },   // 31 days: due
    { ref: "PM-OLD2", status: "expired", expired_at: "2026-09-28T03:00:00Z" },   // 29.98 days: not yet
    { ref: "PM-NOTS", status: "expired", expired_at: null },                    // no stamp: never
    { ref: "PM-LIVE", status: "report_ready", expired_at: "2026-01-01T00:00:00Z" }, // not expired
  ];
  assertEquals(expiredDue(rows, NOW), ["PM-OLD1"]);
});

Deno.test("credit reports: purged 12 months after receipt, once", () => {
  const rows = [
    { ref: "PM-R1", status: "report_ready", report_ready_at: "2025-10-27T10:00:00Z", report_purged_at: null }, // due
    { ref: "PM-R2", status: "report_ready", report_ready_at: "2025-10-29T10:00:00Z", report_purged_at: null }, // 1 day short
    { ref: "PM-R3", status: "report_ready", report_ready_at: "2025-01-01T10:00:00Z", report_purged_at: "2026-01-02T00:00:00Z" }, // done
    { ref: "PM-R4", status: "check_failed", report_ready_at: "2025-01-01T10:00:00Z", report_purged_at: null }, // no report
    { ref: "PM-R5", status: "report_ready", report_ready_at: null, report_purged_at: null },
  ];
  assertEquals(reportsDue(rows, NOW), ["PM-R1"]);
});

Deno.test("monthsBefore keeps the calendar day and clamps short months", () => {
  assertEquals(monthsBefore(new Date("2026-10-28T02:30:00Z"), 12).toISOString(), "2025-10-28T02:30:00.000Z");
  assertEquals(monthsBefore(new Date("2026-03-31T00:00:00Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
  assertEquals(monthsBefore(new Date("2026-01-15T00:00:00Z"), 12).toISOString(), "2025-01-15T00:00:00.000Z");
});

Deno.test("weekly copies: dated folders, pruned after 30 days, other names untouched", () => {
  assertEquals(backupFolder(NOW), "2026-10-28");
  assertEquals(backupPath("2026-10-28", "id-documents", "PM-ABC123/idcopy-x.jpg"), "2026-10-28/id-documents/PM-ABC123/idcopy-x.jpg");
  const names = ["2026-09-27", "2026-09-28", "2026-10-05", "2026-10-28", "notes", ".emptyFolderPlaceholder"];
  assertEquals(foldersToPrune(names, NOW), ["2026-09-27"]);          // 2026-09-28 is exactly 30 days: kept
  assertEquals(foldersToPrune(names, NOW, 7), ["2026-09-27", "2026-09-28", "2026-10-05"]);
});
