// Table column widths depend on fonts, zoom and filters. Sticky offsets must
// follow the rendered widths instead of assuming two fixed 62px columns.
export function observeBoardColumns(shell) {
  const table = shell.querySelector("table");
  const update = () => {
    const cells = table.tHead?.rows[0]?.cells;
    if (!cells?.[1]) return;
    shell.style.setProperty("--draft-column-width", `${cells[0].getBoundingClientRect().width}px`);
    shell.style.setProperty("--rank-column-width", `${cells[1].getBoundingClientRect().width}px`);
  };
  const observer = new ResizeObserver(update);
  observer.observe(table);
  observer.observe(shell);
  update();
  return () => observer.disconnect();
}
