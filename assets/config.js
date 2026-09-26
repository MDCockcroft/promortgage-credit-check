/* Pro Mortgage credit-check tool — backend configuration.
   To go live: paste the values from Supabase dashboard → Settings → API.
   The anon key is safe to ship in client code (it is public by design;
   row-level security is what protects the data).
   Leave both blank to run in local demo mode (browser localStorage). */
window.PM_CONFIG = {
  SUPABASE_URL: 'https://mxakigcvckhmyppoiuds.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_DrNDeaB_61zFz27q1QzW_w_PkiKd-AO'
};
