// mm-maintenance — the SCHEDULED housekeeping function (Operator Agreement with Pro Mortgage, 28 Oct 2026).
// Nobody signs in to it: it is called by two Supabase cron jobs (supabase/cron/retention.sql) with a
// shared secret, MAINTENANCE_TOKEN, in the x-maintenance-token header. Deploy with --no-verify-jwt.
//
// POST { action: 'sweep' }         daily  — deletes applications that expired 30+ days ago (row, secrets,
//                                            files and their weekly copies; a 'deleted' marker stays) and
//                                            purges credit reports received 12+ months ago (data and PDF;
//                                            the risk band and enquiry reference stay — purge_report)
// POST { action: 'backup-files' }  weekly — copies every file in id-documents and credit-reports into
//                                            file-backups/<YYYY-MM-DD>/<bucket>/<path> and removes dated
//                                            folders older than 30 days
// POST { action: 'status' }               — what the next sweep would do, without doing it
//
// Every run logs one JSON line with its counts. A run that cannot finish inside the time budget stops
// cleanly and finishes next time (both actions are idempotent).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fail, ok, preflight } from "../_shared/http.ts";
import { serviceClient, sha256Hex } from "../_shared/db.ts";
import {
  BACKED_UP_BUCKETS, BACKUP_BUCKET, backupFolder, backupPath, EXPIRED_KEEP_DAYS, expiredDue, foldersToPrune,
  REPORT_KEEP_MONTHS, reportsDue,
} from "../_shared/retention.ts";

const BUDGET_MS = 120_000;        // Edge Function hard limit is 150 s — keep headroom
const BATCH = 200;                // rows considered per run
const now = () => new Date();

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return preflight(origin);
  if (req.method !== "POST") return fail("bad_request", "POST only", origin);

  // ---- the shared secret: compared by digest, never missing-and-open ---------------------------
  const expected = (Deno.env.get("MAINTENANCE_TOKEN") ?? "").trim();
  const given = (req.headers.get("x-maintenance-token") ?? "").trim();
  if (!expected || !given || await sha256Hex(expected) !== await sha256Hex(given)) {
    return fail("unauthenticated", "Maintenance token required", origin);
  }

  let body: { action?: string };
  try { body = await req.json(); } catch { return fail("bad_request", "Body must be JSON", origin); }
  const action = body.action;

  let sb: SupabaseClient;
  try { sb = serviceClient(); } catch (e) {
    console.error(JSON.stringify({ event: "config_error", message: String(e) }));
    return fail("config_error", "Service is not configured", origin);
  }
  const started = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - started);

  // Every object under a prefix, page by page, recursing into folders (storage lists one level).
  const listTree = async (bucket: string, prefix: string): Promise<string[]> => {
    const out: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 100, offset });
      if (error) throw new Error(`storage_list_failed: ${bucket}/${prefix}: ${error.message}`);
      for (const o of data ?? []) {
        if (!o?.name) continue;
        const full = prefix ? `${prefix}/${o.name}` : o.name;
        // a folder has no id / metadata; a file does
        if (o.id == null && !o.metadata) out.push(...await listTree(bucket, full));
        else out.push(full);
      }
      if (!data || data.length < 100) return out;
    }
  };
  const removeAll = async (bucket: string, paths: string[]) => {
    for (let i = 0; i < paths.length; i += 100) {
      const rm = await sb.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (rm.error) throw new Error(`storage_remove_failed: ${bucket}: ${rm.error.message}`);
    }
  };
  // The weekly copies of one record's files (every dated folder, both buckets).
  const removeBackupsFor = async (ref: string, buckets: readonly string[] = BACKED_UP_BUCKETS) => {
    const { data: folders, error } = await sb.storage.from(BACKUP_BUCKET).list("", { limit: 100 });
    if (error) throw new Error(`storage_list_failed: ${BACKUP_BUCKET}: ${error.message}`);
    for (const f of folders ?? []) {
      if (!f?.name || !/^\d{4}-\d{2}-\d{2}$/.test(f.name)) continue;
      for (const b of buckets) {
        const paths = await listTree(BACKUP_BUCKET, `${f.name}/${b}/${ref}`);
        if (paths.length) await removeAll(BACKUP_BUCKET, paths);
      }
    }
  };

  try {
    // ======================================================================================
    if (action === "status" || action === "sweep") {
      const { data: expiredRows, error: e1 } = await sb.from("credit_checks")
        .select("ref, status, expired_at").eq("status", "expired").not("expired_at", "is", null)
        .order("expired_at", { ascending: true }).limit(BATCH);
      if (e1) throw new Error(`server_error: ${e1.message}`);
      const { data: reportRows, error: e2 } = await sb.from("credit_checks")
        .select("ref, status, report_ready_at, report_purged_at").eq("status", "report_ready").is("report_purged_at", null)
        .order("report_ready_at", { ascending: true }).limit(BATCH);
      if (e2) throw new Error(`server_error: ${e2.message}`);
      const toDelete = expiredDue(expiredRows ?? [], now());
      const toPurge = reportsDue(reportRows ?? [], now());
      if (action === "status") {
        return ok({ expiredDue: toDelete.length, reportsDue: toPurge.length, keepDays: EXPIRED_KEEP_DAYS, keepMonths: REPORT_KEEP_MONTHS }, origin);
      }

      let deleted = 0, purged = 0;
      const problems: string[] = [];
      // (a) expired applications: files first (the record is the only index to them), then the row.
      for (const ref of toDelete) {
        if (timeLeft() < 15_000) break;
        try {
          for (const b of BACKED_UP_BUCKETS) {
            const paths = await listTree(b, ref);
            if (paths.length) await removeAll(b, paths);
          }
          await removeBackupsFor(ref);
          const blank = await sb.from("mm_api_log").update({ body_head: null }).eq("ref", ref);
          if (blank.error) throw new Error(`server_error: ${blank.error.message}`);
          const del = await sb.from("credit_checks").delete().eq("ref", ref).eq("status", "expired");
          if (del.error) throw new Error(`server_error: ${del.error.message}`);
          const marker = await sb.from("consent_events").insert({ ref, event: "deleted", created_by: "retention (expired 30 days)" });
          if (marker.error) console.error(JSON.stringify({ event: "deleted_marker_failed", ref, message: marker.error.message }));
          deleted++;
        } catch (e) {
          problems.push(`${ref}: ${String(e instanceof Error ? e.message : e)}`);
        }
      }
      // (b) credit reports: the database reduces the record and hands back the PDF path to delete.
      for (const ref of toPurge) {
        if (timeLeft() < 15_000) break;
        try {
          const { data: pdfPath, error } = await sb.rpc("purge_report", { p_ref: ref });
          if (error) throw new Error(`server_error: ${error.message}`);
          if (typeof pdfPath === "string" && pdfPath) {
            await removeAll("credit-reports", [pdfPath]);
          }
          // whatever is left of the record's report PDFs, and their weekly copies
          const rest = await listTree("credit-reports", ref);
          if (rest.length) await removeAll("credit-reports", rest);
          await removeBackupsFor(ref, ["credit-reports"]);
          purged++;
        } catch (e) {
          problems.push(`${ref}: ${String(e instanceof Error ? e.message : e)}`);
        }
      }
      const summary = { event: "retention_sweep", deleted, purged, due: { expired: toDelete.length, reports: toPurge.length }, problems: problems.length, ms: Date.now() - started };
      console.log(JSON.stringify(summary));
      if (problems.length) console.error(JSON.stringify({ event: "retention_sweep_problems", problems }));
      return ok({ ...summary, problems }, origin);
    }

    // ======================================================================================
    if (action === "backup-files") {
      const folder = backupFolder(now());
      let copied = 0, skipped = 0, pruned = 0;
      const problems: string[] = [];
      for (const bucket of BACKED_UP_BUCKETS) {
        const paths = await listTree(bucket, "");
        for (const path of paths) {
          if (timeLeft() < 10_000) { problems.push("time budget reached — the rest copies next run"); break; }
          const dest = backupPath(folder, bucket, path);
          try {
            const { data: blob, error: dlErr } = await sb.storage.from(bucket).download(path);
            if (dlErr || !blob) throw new Error(`download: ${dlErr?.message ?? "no data"}`);
            const up = await sb.storage.from(BACKUP_BUCKET).upload(dest, blob, { upsert: true, contentType: blob.type || "application/octet-stream" });
            if (up.error) throw new Error(`upload: ${up.error.message}`);
            copied++;
          } catch (e) {
            problems.push(`${bucket}/${path}: ${String(e instanceof Error ? e.message : e)}`); skipped++;
          }
        }
      }
      // Dated folders older than the keep period go, whole.
      const { data: folders, error: lf } = await sb.storage.from(BACKUP_BUCKET).list("", { limit: 100 });
      if (lf) throw new Error(`storage_list_failed: ${BACKUP_BUCKET}: ${lf.message}`);
      for (const old of foldersToPrune((folders ?? []).map((f) => f?.name ?? ""), now())) {
        if (timeLeft() < 10_000) break;
        try {
          const paths = await listTree(BACKUP_BUCKET, old);
          if (paths.length) await removeAll(BACKUP_BUCKET, paths);
          pruned++;
        } catch (e) {
          problems.push(`${old}: ${String(e instanceof Error ? e.message : e)}`);
        }
      }
      const summary = { event: "file_backup", folder, copied, skipped, pruned, problems: problems.length, ms: Date.now() - started };
      console.log(JSON.stringify(summary));
      if (problems.length) console.error(JSON.stringify({ event: "file_backup_problems", problems }));
      return ok({ ...summary, problems }, origin);
    }

    return fail("bad_request", `Unknown action ${action}`, origin);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(JSON.stringify({ event: "mm_maintenance_error", action, message: msg }));
    return fail("server_error", "Something went wrong", origin);
  }
});
