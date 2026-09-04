"""Interactive desktop draft board and data updater."""

import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from config import ADP_DIR, OUTPUT_DIR, PROJECTION_SEASON, STAT_SEASON
from app.draft_board_service import DraftedPlayerStore, LeagueSettings, load_rankings, prepare_rankings
from app.platform_utils import open_file
from refresh_draft_board import refresh_draft_board

DISPLAY_COLUMNS = (
    ("drafted", "Drafted", 65),
    ("overall_rank", "Rank", 55), ("player", "Player", 175), ("team", "Team", 55),
    ("pos", "Pos", 48), ("position_rank", "Pos Rank", 70),
    ("projected_points", "Projected", 82), ("vorp", "VORP", 72),
    ("market_value", "Market +/-", 82),
    ("adp", "ADP", 65), ("value_vs_adp", "Value", 65),
    ("Yahoo", "Yahoo", 65), ("Sleeper", "Sleeper", 65),
    ("NFL", "NFL/ESPN", 75), ("draft_tag", "Draft Tag", 75),
)
DECIMAL_COLUMNS = {
    "projected_points", "vorp", "market_value", "adp", "value_vs_adp",
    "Yahoo", "Sleeper", "NFL",
}


def format_table_value(column, value):
    """Format one cell while safely handling unavailable numeric data."""
    if column == "drafted":
        return "✓" if bool(value) else ""
    if column not in DECIMAL_COLUMNS:
        return "" if value is None else value
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    return "" if number != number else f"{number:.1f}"


class DraftBoardApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Project Foot Moneyball")
        self.geometry("1180x760")
        self.minsize(900, 620)
        self.configure(bg="#17233b")
        self.messages = queue.Queue()
        self.result_path = None
        self.rankings = None
        self.sort_column = "overall_rank"
        self.sort_ascending = True
        self.active_filter_column = "player"
        self.active_filter_query = ""
        self.drafted_store = DraftedPlayerStore(OUTPUT_DIR / "drafted_players.json")
        self._configure_styles()
        self._build_header()
        self._build_controls()
        self._build_table()
        self.after(100, self._read_messages)
        self.after(250, self.load_selected_board)

    def _configure_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Title.TLabel", background="#17233b", foreground="white", font=("Segoe UI", 20, "bold"))
        style.configure("Sub.TLabel", background="#17233b", foreground="#d9eaf7")
        style.configure("Card.TFrame", background="white")
        style.configure("Card.TLabel", background="white", foreground="#17233b")
        style.configure("Action.TButton", font=("Segoe UI", 10, "bold"), padding=8)
        style.configure("Treeview", rowheight=26, font=("Segoe UI", 9))
        style.configure("Treeview.Heading", background="#2f75b5", foreground="white", font=("Segoe UI", 9, "bold"))

    def _build_header(self):
        ttk.Label(self, text="Project Foot Moneyball", style="Title.TLabel").pack(pady=(16, 1))
        ttk.Label(self, text=f"{PROJECTION_SEASON} interactive draft board • {STAT_SEASON} season stats", style="Sub.TLabel").pack()

    def _build_controls(self):
        card = ttk.Frame(self, style="Card.TFrame", padding=12)
        card.pack(fill="x", padx=20, pady=(12, 8))
        self.teams, self.qbs = tk.StringVar(value="12"), tk.StringVar(value="2QB")
        self.ppr, self.premium = tk.StringVar(value="Half PPR"), tk.StringVar(value="+0.5")
        choices = (("Teams", self.teams, ("8", "10", "12", "14", "16")),
                   ("QB", self.qbs, ("1QB", "2QB")),
                   ("PPR", self.ppr, ("Standard", "Half PPR", "Full PPR")),
                   ("TE Premium", self.premium, ("Off", "+0.5")))
        for index, (label, variable, values) in enumerate(choices):
            ttk.Label(card, text=label, style="Card.TLabel").grid(row=0, column=index, sticky="w", padx=(0, 8))
            box = ttk.Combobox(card, textvariable=variable, values=values, state="readonly", width=12)
            box.grid(row=1, column=index, sticky="ew", padx=(0, 8))
            box.bind("<<ComboboxSelected>>", lambda _event: self.load_selected_board())
        self.adp_source = tk.StringVar()
        ttk.Label(card, text="ADP URL or saved HTML (optional)", style="Card.TLabel").grid(row=0, column=4, columnspan=2, sticky="w")
        ttk.Entry(card, textvariable=self.adp_source).grid(row=1, column=4, sticky="ew")
        ttk.Button(card, text="Browse…", command=self._choose_adp).grid(row=1, column=5, padx=(6, 8))
        self.keep_stats = tk.BooleanVar(value=True)
        ttk.Checkbutton(card, text="Reuse saved stats", variable=self.keep_stats).grid(row=0, column=6, sticky="w")
        self.run_button = ttk.Button(card, text="Update Data", style="Action.TButton", command=self._start_refresh)
        self.run_button.grid(row=1, column=6, sticky="ew")
        ttk.Button(card, text="Open Excel", command=self._open_result).grid(row=1, column=7, padx=(8, 0))
        card.columnconfigure(4, weight=1)

    def _build_table(self):
        panel = ttk.Frame(self, style="Card.TFrame", padding=10)
        panel.pack(fill="both", expand=True, padx=20, pady=(0, 12))
        toolbar = ttk.Frame(panel, style="Card.TFrame")
        toolbar.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        ttk.Label(toolbar, text="Filter column", style="Card.TLabel").pack(side="left")
        self.filter_column = tk.StringVar(value="Player")
        filter_titles = [title for _key, title, _width in DISPLAY_COLUMNS]
        filter_box = ttk.Combobox(toolbar, textvariable=self.filter_column, values=filter_titles,
                                  state="readonly", width=13)
        filter_box.pack(side="left", padx=(6, 6))
        filter_box.bind("<<ComboboxSelected>>", self._on_filter_column_changed)
        self.filter_text = tk.StringVar()
        filter_entry = ttk.Entry(toolbar, textvariable=self.filter_text, width=24)
        filter_entry.pack(side="left")
        filter_entry.bind("<Return>", lambda _event: self._apply_filter())
        ttk.Button(toolbar, text="Apply", command=self._apply_filter).pack(side="left", padx=(6, 0))
        ttk.Button(toolbar, text="Show All", command=self._clear_filter).pack(side="left", padx=6)
        ttk.Label(toolbar, text="Press Enter to apply • commas mean OR", style="Card.TLabel").pack(side="left")
        ttk.Button(toolbar, text="Mark/Undo Drafted", command=self._toggle_selected_drafted).pack(side="right")
        ttk.Button(toolbar, text="Reset Draft", command=self._reset_draft).pack(side="right", padx=6)
        keys = [column[0] for column in DISPLAY_COLUMNS]
        self.table = ttk.Treeview(panel, columns=keys, show="headings")
        for key, title, width in DISPLAY_COLUMNS:
            self.table.heading(key, text=title, command=lambda selected=key: self._sort_by(selected))
            self.table.column(key, width=width, minwidth=45, anchor="w" if key == "player" else "center")
        for tag, color in (("TARGET", "#c6efce"), ("VALUE", "#fff2cc"), ("REACH", "#ffc7ce")):
            self.table.tag_configure(tag, background=color)
        self.table.tag_configure("DRAFTED", background="#e5e7eb", foreground="#9ca3af")
        self.table.bind("<Double-1>", lambda _event: self._toggle_selected_drafted())
        vertical = ttk.Scrollbar(panel, orient="vertical", command=self.table.yview)
        horizontal = ttk.Scrollbar(panel, orient="horizontal", command=self.table.xview)
        self.table.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        self.table.grid(row=1, column=0, sticky="nsew")
        vertical.grid(row=1, column=1, sticky="ns")
        horizontal.grid(row=2, column=0, sticky="ew")
        panel.rowconfigure(1, weight=1)
        panel.columnconfigure(0, weight=1)
        self.progress = ttk.Progressbar(panel, mode="indeterminate")
        self.progress.grid(row=3, column=0, sticky="ew", pady=(8, 0))
        self.status_text = tk.StringVar(value="Ready.")
        ttk.Label(panel, textvariable=self.status_text, style="Card.TLabel").grid(row=4, column=0, sticky="w", pady=(6, 0))

    def current_settings(self):
        return LeagueSettings(int(self.teams.get()), self.qbs.get(), self.ppr.get(), self.premium.get())

    def load_selected_board(self):
        try:
            self.rankings = load_rankings(OUTPUT_DIR, self.current_settings())
        except FileNotFoundError as exc:
            self.status_text.set(str(exc))
            return
        self.sort_column = "overall_rank"
        self.sort_ascending = True
        self._clear_filter(render=False)
        self._render_rankings()

    def _render_rankings(self):
        if self.rankings is None:
            return
        rankings = prepare_rankings(
            self.rankings,
            self.drafted_store,
            filter_column=self.active_filter_column,
            query=self.active_filter_query,
            sort_column=self.sort_column,
            ascending=self.sort_ascending,
        )
        self.table.delete(*self.table.get_children())
        keys = [column[0] for column in DISPLAY_COLUMNS]
        for _, row in rankings.iterrows():
            drafted = bool(row.get("drafted", False))
            values = []
            for key in keys:
                values.append(format_table_value(key, row.get(key, "")))
            tag = "DRAFTED" if drafted else str(row.get("draft_tag", "FAIR"))
            self.table.insert("", "end", values=values, tags=(tag,))
        drafted_count = sum(self.drafted_store.contains(row.get("player", ""), row.get("team", "")) for _, row in self.rankings.iterrows())
        total = len(self.rankings)
        filter_status = " • filter active" if self.active_filter_query else ""
        self.status_text.set(
            f"Showing {len(rankings)} of {total} players{filter_status} • "
            f"{drafted_count} drafted • click a header to sort"
        )

    def _sort_by(self, column):
        if self.sort_column == column:
            self.sort_ascending = not self.sort_ascending
        else:
            self.sort_column, self.sort_ascending = column, True
        self._render_rankings()

    def _on_filter_column_changed(self, _event=None):
        # A query that made sense for Player should not silently carry over to ADP, Pos, etc.
        self._clear_filter()

    def _apply_filter(self):
        title_to_key = {title: key for key, title, _width in DISPLAY_COLUMNS}
        self.active_filter_column = title_to_key.get(self.filter_column.get(), "player")
        self.active_filter_query = self.filter_text.get().strip()
        self._render_rankings()

    def _clear_filter(self, render=True):
        self.filter_text.set("")
        self.active_filter_query = ""
        if render:
            self._render_rankings()

    def _toggle_selected_drafted(self):
        selected = self.table.selection()
        if not selected:
            return
        values = self.table.item(selected[0], "values")
        keys = [column[0] for column in DISPLAY_COLUMNS]
        row = dict(zip(keys, values))
        self.drafted_store.toggle(row.get("player", ""), row.get("team", ""))
        self._render_rankings()

    def _reset_draft(self):
        if messagebox.askyesno("Reset draft", "Clear every drafted-player marker?"):
            self.drafted_store.clear()
            self._render_rankings()

    def _choose_adp(self):
        selected = filedialog.askopenfilename(
            initialdir=ADP_DIR,
            filetypes=[("HTML pages", ("*.html", "*.htm")), ("All files", "*.*")],
        )
        if selected:
            self.adp_source.set(selected)

    def _start_refresh(self):
        self.run_button.configure(state="disabled")
        self.progress.start(10)
        threading.Thread(target=self._run_refresh, daemon=True).start()

    def _run_refresh(self):
        try:
            result = refresh_draft_board(adp_source=self.adp_source.get().strip() or None,
                                         keep_stats=self.keep_stats.get(),
                                         status=lambda message: self.messages.put(("status", message)))
            self.messages.put(("done", result))
        except Exception as exc:
            self.messages.put(("error", str(exc)))

    def _read_messages(self):
        try:
            while True:
                kind, payload = self.messages.get_nowait()
                if kind == "status":
                    self.status_text.set(payload)
                elif kind == "done":
                    self.result_path = Path(payload)
                    self._finish_refresh()
                    self.load_selected_board()
                    messagebox.showinfo("Draft board ready", "The rankings and spreadsheet were updated.")
                else:
                    self._finish_refresh()
                    messagebox.showerror("Update failed", payload)
        except queue.Empty:
            pass
        self.after(100, self._read_messages)

    def _finish_refresh(self):
        self.progress.stop()
        self.run_button.configure(state="normal")

    def _open_result(self):
        path = self.result_path or OUTPUT_DIR / "ProjectFootMoneyball_Draft_Board.xlsx"
        if Path(path).exists():
            open_file(path)
        else:
            messagebox.showinfo("No spreadsheet yet", "Click Update Data first.")


if __name__ == "__main__":
    DraftBoardApp().mainloop()
