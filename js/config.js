// Sync backend configuration (Supabase). When empty, the app runs in
// local-only mode: everything works on this device but is not shared.
window.WC_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
  // ESPN public scoreboard feed for FIFA World Cup 2026
  espnScoreboard: "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=300",
  flag: (abbrev) => "https://a.espncdn.com/i/teamlogos/countries/500/" + ({
    // ESPN logo slugs that differ from lowercased abbreviation are mapped in teams.json logos
  }[abbrev] || abbrev.toLowerCase()) + ".png",
};
