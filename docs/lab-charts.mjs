const ns = "http://www.w3.org/2000/svg";
const colors = {QB: "#8cc6ff", RB: "#d7ff54", WR: "#ffbc80", TE: "#d6b3ff"};
const node = (name, attributes = {}, text) => {
  const result = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
  if (text !== undefined) result.textContent = text;
  return result;
};

export function careerRelativeSamples(samples, position) {
  const groups = new Map();
  for (const row of samples.filter(row => row.pos === position && row.games >= 6)) {
    if (!groups.has(row.identity)) groups.set(row.identity, []);
    groups.get(row.identity).push(row);
  }
  return [...groups.values()].filter(rows => rows.length >= 3).flatMap(rows => {
    const peak = Math.max(...rows.map(row => row.fantasy_points_per_game));
    return peak > 0 ? rows.map(row => ({...row, fantasy_points_per_game: row.fantasy_points_per_game / peak * 100})) : [];
  });
}

// Connect only adjacent rounds; a missing sample is not a zero or an interpolated result.
export function roundLineSegments(cells, position) {
  const segments = []; let current = [];
  for (let round = 1; round <= 15; round++) {
    const cell = cells.find(item => item.round === round && item.pos === position);
    if (!cell?.count || !Number.isFinite(cell.mean)) { if (current.length) segments.push(current); current = []; }
    else current.push(cell);
  }
  if (current.length) segments.push(current);
  return segments;
}

export function renderRoundChart(target, cells, selected = "all") {
  const positions = selected === "all" ? Object.keys(colors) : [selected];
  const useful = cells.filter(cell => positions.includes(cell.pos) && cell.count && Number.isFinite(cell.mean));
  target.replaceChildren();
  if (!useful.length) { target.textContent = "No scoring samples for this selection."; return; }
  const width = 980, height = 370, max = Math.max(1, ...useful.map(cell => cell.mean + (selected === "all" ? 0 : cell.stddev || 0))) * 1.1;
  const x = round => 64 + (round - 1) / 14 * 870, y = score => 310 - Math.max(0, score) / max * 270;
  const svg = node("svg", {viewBox: `0 0 ${width} ${height}`, class: "round-points-chart", role: "img", "aria-label": "Season scoring by draft round and position. Exact averages and standard deviations are in the draft capital table below."});
  for (let i = 0; i <= 4; i++) {
    const score = max * i / 4;
    svg.append(node("line", {x1: 64, x2: 934, y1: y(score), y2: y(score), stroke: "#365145"}), node("text", {x: 52, y: y(score) + 5, "text-anchor": "end"}, Math.round(score)));
  }
  for (let round = 1; round <= 15; round++) svg.append(node("text", {x: x(round), y: 337, "text-anchor": "middle"}, round));
  svg.append(node("text", {x: 64, y: 22}, "Season fantasy points"), node("text", {x: 500, y: 363, "text-anchor": "middle"}, "Draft round"));
  for (const position of positions) {
    const color = colors[position];
    for (const segment of roundLineSegments(cells, position)) {
      if (selected !== "all") {
        const upper = segment.map(cell => `${x(cell.round)},${y(cell.mean + (cell.stddev || 0))}`);
        const lower = [...segment].reverse().map(cell => `${x(cell.round)},${y(cell.mean - (cell.stddev || 0))}`);
        svg.append(node("polygon", {points: [...upper, ...lower].join(" "), fill: color, opacity: .12}));
      }
      svg.append(node("polyline", {points: segment.map(cell => `${x(cell.round)},${y(cell.mean)}`).join(" "), fill: "none", stroke: color, "stroke-width": 3}));
      for (const cell of segment) {
        const point = node("circle", {cx: x(cell.round), cy: y(cell.mean), r: 5, fill: color});
        point.append(node("title", {}, `${position} round ${cell.round}: ${cell.mean.toFixed(1)} points, SD ${cell.stddev?.toFixed(1) ?? "unavailable"}, n=${cell.count}`)); svg.append(point);
      }
    }
  }
  target.append(svg);
}
