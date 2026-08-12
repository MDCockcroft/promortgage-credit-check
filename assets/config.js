/* Pro Mortgage credit-check tool — backend configuration.
   To go live: paste the values from Supabase dashboard → Settings → API.
   The anon key is safe to ship in client code (it is public by design;
   row-level security is what protects the data).
   Leave both blank to run in local demo mode (browser localStorage). */
window.PM_CONFIG = {
  SUPABASE_URL: 'https://nzjhgsnxeecxlijuhkai.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56amhnc254ZWVjeGxpanVoa2FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MjU2MjMsImV4cCI6MjEwMjEwMTYyM30.i5xJY8CO6CabvBytlqumdPgtvnhdBpCp03gBzgtiqZ8'
};
