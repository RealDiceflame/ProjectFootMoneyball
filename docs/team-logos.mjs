// Reuse the same team assets as Weekly odds. These are team marks, not endorsements.
export function teamLogoUrl(team) {
  const codes = "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAC LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(" ");
  if (!codes.includes(team)) return null;
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${({LA:"lar", WAS:"wsh"}[team] || team.toLowerCase())}.png`;
}

export function teamMark(team) {
  const mark = document.createElement("img");
  mark.src = teamLogoUrl(team); mark.alt = ""; mark.width = 32; mark.height = 32;
  mark.loading = "lazy"; mark.decoding = "async"; mark.referrerPolicy = "no-referrer";
  mark.className = "team-logo";
  mark.addEventListener("error", () => { mark.hidden = true; }, {once:true});
  return mark;
}
