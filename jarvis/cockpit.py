"""Connection to the Startup-Cockpit (Supabase RPC functions, authorised by the team code).

Uses the same calls as the cockpit web page: board_get, board_kpis, board_task_add,
board_set_status and board_post_to. Configure in config.json:

    "cockpit": {"supabase_url": "...", "anon_key": "...", "team_code": "...", "who": "olivia",
                "web_url": "https://dashboard-startup.netlify.app/"}
"""

import time
from datetime import date

import requests

RANK = {"late": 0, "woche": 1, "monat": 2, "quartal": 3, "spaeter": 4}
HORIZON_DE = {"late": "überfällig", "woche": "diese Woche", "monat": "diesen Monat",
              "quartal": "dieses Quartal", "spaeter": "später"}
KPI_LABELS = {
    "bewerbungen": "Bewerbungen", "bewerbungen_7t": "Bewerbungen 7 Tage",
    "bewerbungen_offen": "Warten aufs Komitee", "mitglieder": "Mitglieder",
    "partner_aktiv": "Partner aktiv", "abende": "Abende", "buchungen": "Buchungen", "zahlend": "Zahlende",
}


class CockpitError(RuntimeError):
    pass


class Cockpit:
    def __init__(self, cfg: dict):
        c = cfg.get("cockpit") or {}
        self.url = (c.get("supabase_url") or "").rstrip("/")
        self.key = c.get("anon_key") or ""
        self.code = c.get("team_code") or ""
        self.who = c.get("who") or "olivia"
        self.web_url = c.get("web_url") or ""
        self._cache: dict[str, tuple[float, object]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.key and self.code)

    # ---------- transport ----------

    def _rpc(self, fn: str, **args):
        if not self.enabled:
            raise CockpitError("Cockpit ist nicht verbunden (team_code in config.json fehlt).")
        try:
            resp = requests.post(
                f"{self.url}/rest/v1/rpc/{fn}",
                headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"},
                json={"p_code": self.code, **args},
                timeout=15,
            )
        except requests.RequestException as e:
            raise CockpitError(f"Cockpit nicht erreichbar: {e}") from e
        try:
            data = resp.json() if resp.text else None
        except ValueError:
            data = None
        if not resp.ok:
            msg = (data or {}).get("message") or (data or {}).get("error") or f"HTTP {resp.status_code}"
            if msg == "falscher_code":
                msg = "Der Team-Code stimmt nicht."
            elif msg == "permission_denied":
                msg = "Mit diesem Team-Code gibt es nur Leserechte."
            raise CockpitError(msg)
        return data

    def _cached(self, key: str, ttl: float, fetch):
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        value = fetch()
        self._cache[key] = (time.monotonic(), value)
        return value

    def _invalidate(self):
        self._cache.pop("board", None)

    def board(self) -> dict:
        return self._cached("board", 20, lambda: self._rpc("board_get") or {})

    def kpis(self) -> dict:
        return self._cached("kpis", 300, lambda: self._rpc("board_kpis") or {})

    # ---------- reading ----------

    @staticmethod
    def bucket(task: dict) -> str:
        """Same urgency buckets as the cockpit page."""
        due = task.get("due")
        if due:
            try:
                days = (date.fromisoformat(due[:10]) - date.today()).days
            except ValueError:
                days = 999
            if days < 0:
                return "late"
            if days <= 7:
                return "woche"
            if days <= 31:
                return "monat"
            if days <= 105:
                return "quartal"
            return "spaeter"
        h = task.get("horizon")
        return h if h in RANK and h != "late" else "spaeter"

    def projects(self) -> list[dict]:
        ps = self.board().get("projects") or []
        return sorted(ps, key=lambda p: (not p.get("main"), p.get("ord") if p.get("ord") is not None else 99, str(p.get("name"))))

    def project_names(self) -> dict[str, str]:
        return {p["id"]: p.get("name") or p["id"] for p in self.projects()}

    def open_tasks(self, project: str = "", mine_only: bool = False) -> list[dict]:
        names = self.project_names()
        want = project.strip().lower()
        out = []
        for t in self.board().get("tasks") or []:
            if t.get("status") == "erledigt":
                continue
            pid = t.get("project") or "blynk"
            if want and want not in (pid.lower(), names.get(pid, "").lower()):
                continue
            if mine_only and t.get("owner") not in (self.who, "beide", None, ""):
                continue
            out.append({**t, "project": pid, "project_name": names.get(pid, pid), "bucket": self.bucket(t)})
        out.sort(key=lambda t: (RANK[t["bucket"]], str(t.get("due") or "9"), t.get("ord") or 0))
        return out

    def name_of(self, who: str | None) -> str:
        names = {"olivia": "Olivia", "arbon": "Arbon", **(self.board().get("names") or {})}
        return names.get(who or "", who or "jemand")

    def messages(self, limit: int = 5) -> list[dict]:
        msgs = self.board().get("messages") or []
        msgs = sorted(msgs, key=lambda m: str(m.get("at") or ""))
        return msgs[-limit:]

    # ---------- summaries for Claude ----------

    def overview(self) -> str:
        lines = []
        for p in self.projects():
            open_ = [t for t in self.open_tasks(p["id"])]
            late = sum(t["bucket"] == "late" for t in open_)
            week = sum(t["bucket"] == "woche" for t in open_)
            ms = f"; Meilenstein: {p.get('ms_label') or ''} {p.get('ms_date') or ''}".rstrip() if (p.get("ms_label") or p.get("ms_date")) else ""
            lines.append(
                f"- {p.get('name')} ({p['id']}): Status {p.get('status') or '-'}; nächster Schritt: {p.get('next') or '-'}; "
                f"{len(open_)} offene Aufgaben ({late} überfällig, {week} diese Woche){ms}"
            )
        return "Projekte im Cockpit:\n" + "\n".join(lines) if lines else "Keine Projekte im Cockpit."

    def tasks_text(self, project: str = "", mine_only: bool = False, limit: int = 15) -> str:
        tasks = self.open_tasks(project, mine_only)
        if not tasks:
            return "Keine offenen Aufgaben" + (f" für {project}." if project else ".")
        rows = []
        for t in tasks[:limit]:
            due = f", fällig {t['due']}" if t.get("due") else ""
            owner = f", {self.name_of(t.get('owner'))}" if t.get("owner") else ""
            rows.append(f"- [{t['id']}] {t['title']} ({t['project_name']}, {HORIZON_DE[t['bucket']]}{due}{owner})")
        more = f"\n... und {len(tasks) - limit} weitere" if len(tasks) > limit else ""
        return f"Offene Aufgaben ({len(tasks)}):\n" + "\n".join(rows) + more

    def kpis_text(self) -> str:
        k = self.kpis()
        if not k:
            return "Noch keine App-Zahlen."
        parts = [f"{label}: {k[key]}" for key, label in KPI_LABELS.items() if k.get(key) is not None]
        return "BLYNK-App live: " + ", ".join(parts) + (f" (Stand {k['stand']})" if k.get("stand") else "")

    def messages_text(self, limit: int = 5) -> str:
        msgs = self.messages(limit)
        if not msgs:
            return "Keine Team-Nachrichten."
        return "Letzte Team-Nachrichten:\n" + "\n".join(
            f"- {self.name_of(m.get('who'))} ({str(m.get('at') or '')[:16].replace('T', ' ')}): {m.get('text')}" for m in msgs
        )

    # ---------- writing ----------

    def resolve_project(self, project: str) -> str:
        want = project.strip().lower()
        for pid, name in self.project_names().items():
            if want in (pid.lower(), name.lower()):
                return pid
        known = ", ".join(self.project_names().values())
        raise CockpitError(f"Projekt '{project}' gibt es im Cockpit nicht. Vorhanden: {known}.")

    def add_task(self, project: str, title: str, due: str = "", detail: str = "", owner: str = "") -> str:
        pid = self.resolve_project(project)
        name = self.project_names()[pid]
        self._rpc("board_task_add", p_who=self.who, p_project=pid, p_title=title.strip(),
                  p_done_when=detail.strip() or None, p_owner=owner.strip().lower() or None,
                  p_due=due or None, p_horizon=None if due else "monat")
        self._invalidate()
        return f"Aufgabe '{title}' in {name} angelegt."

    def complete_task(self, task_id: str) -> str:
        task = next((t for t in self.board().get("tasks") or [] if str(t.get("id")) == str(task_id)), None)
        if not task:
            raise CockpitError(f"Keine Aufgabe mit der ID {task_id}. Erst get_cockpit_tasks aufrufen.")
        self._rpc("board_set_status", p_id=task["id"], p_status="erledigt", p_who=self.who)
        self._invalidate()
        return f"'{task['title']}' ist erledigt."

    def post_message(self, text: str, project: str = "") -> str:
        pid = self.resolve_project(project) if project else None
        self._rpc("board_post_to", p_who=self.who, p_text=text.strip(), p_project=pid)
        self._invalidate()
        return "Nachricht im Team-Chat gepostet."

    # ---------- HUD ----------

    def hud(self) -> dict:
        """Compact cockpit data for the HUD panels; errors are reported, not raised."""
        if not self.enabled:
            return {"connected": False}
        try:
            kpis = self.kpis()
        except CockpitError:
            kpis = {}
        try:
            names = self.project_names()
            tasks = self.open_tasks(mine_only=True)
            return {
                "connected": True,
                "web_url": self.web_url,
                "projects": [
                    {"id": p["id"], "name": p.get("name"), "status": p.get("status"), "next": p.get("next"),
                     "color": p.get("color"), "open": sum(t["project"] == p["id"] for t in tasks),
                     "late": sum(t["project"] == p["id"] and t["bucket"] == "late" for t in tasks)}
                    for p in self.projects()
                ],
                "tasks": [{"title": t["title"], "project": names.get(t["project"], t["project"]),
                           "bucket": t["bucket"], "due": t.get("due")} for t in tasks[:8]],
                "messages": [{"who": self.name_of(m.get("who")), "text": m.get("text"), "at": m.get("at")}
                             for m in self.messages(3)],
                "kpis": {label: kpis[key] for key, label in KPI_LABELS.items() if kpis.get(key) is not None},
            }
        except CockpitError as e:
            return {"connected": False, "error": str(e)}
