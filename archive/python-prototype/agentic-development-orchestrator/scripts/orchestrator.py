#!/usr/bin/env python3
"""Deterministic control-plane utilities. Does not invoke coding agents."""
from __future__ import annotations
import argparse, json, os, sys, tempfile, subprocess
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict, deque

TASK_STATES = {
    "PLANNED": {"READY", "BLOCKED"},
    "READY": {"RUNNING", "BLOCKED"},
    "RUNNING": {"REVIEW", "BLOCKED"},
    "REVIEW": {"PASS", "REWORK", "BLOCKED"},
    "REWORK": {"RUNNING", "BLOCKED"},
    "PASS": {"INTEGRATED", "BLOCKED"},
    "INTEGRATED": set(),
    "BLOCKED": {"READY"},
}
MILESTONE_STATES = {
    "PLANNED": {"ACTIVE", "BLOCKED"},
    "ACTIVE": {"REVIEW", "BLOCKED"},
    "REVIEW": {"PASS", "FAIL", "BLOCKED"},
    "FAIL": {"ACTIVE", "BLOCKED"},
    "PASS": set(),
    "BLOCKED": {"ACTIVE"},
}

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def load_config(path):
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError as exc:
            raise ValueError("YAML input requires PyYAML. Install it or use JSON syntax.") from exc
        data = yaml.safe_load(raw)
        if not isinstance(data, dict):
            raise ValueError("Configuration root must be a mapping.")
        return data

def validate_config(c):
    errors = []
    for key in ("project", "sources", "agents", "tasks", "execution", "git", "verification", "approvals", "state", "delivery"):
        if key not in c: errors.append(f"Missing top-level key: {key}")
    project = c.get("project", {})
    if not project.get("id"): errors.append("project.id is required")
    if not project.get("repository"): errors.append("project.repository is required")
    agents = c.get("agents", [])
    agent_ids = [a.get("id") for a in agents]
    if len(agent_ids) != len(set(agent_ids)): errors.append("Agent IDs must be unique")
    known = set(agent_ids)
    tasks = c.get("tasks", [])
    task_ids = [t.get("id") for t in tasks]
    if len(task_ids) != len(set(task_ids)): errors.append("Task IDs must be unique")
    known_tasks = set(task_ids)
    for t in tasks:
        for field in ("id", "milestone", "title", "goal", "acceptance_criteria", "implementer", "reviewer"):
            if field not in t: errors.append(f"{t.get('id','<unknown>')}: missing {field}")
        if t.get("implementer") not in known: errors.append(f"{t.get('id')}: unknown implementer {t.get('implementer')}")
        if t.get("reviewer") not in known: errors.append(f"{t.get('id')}: unknown reviewer {t.get('reviewer')}")
        if t.get("implementer") == t.get("reviewer"): errors.append(f"{t.get('id')}: reviewer must differ from implementer")
        for dep in t.get("depends_on", []):
            if dep not in known_tasks: errors.append(f"{t.get('id')}: unknown dependency {dep}")
    execution = c.get("execution", {})
    for k in ("max_parallel_tasks", "max_parallel_agents", "max_rework_rounds"):
        if k in execution and (not isinstance(execution[k], int) or execution[k] < 1):
            errors.append(f"execution.{k} must be a positive integer")
    return errors

def norm_path(p):
    return str(Path(p).as_posix()).strip("./")

def scopes_overlap(a, b):
    a, b = norm_path(a), norm_path(b)
    return a == b or a.startswith(b + "/") or b.startswith(a + "/") or a in ("", ".") or b in ("", ".")

def build_plan(c):
    tasks = c.get("tasks", [])
    by_id = {t["id"]: t for t in tasks}
    indegree = {t["id"]: 0 for t in tasks}
    children = defaultdict(list)
    for t in tasks:
        for dep in t.get("depends_on", []):
            if dep in by_id:
                indegree[t["id"]] += 1
                children[dep].append(t["id"])
    q = deque(sorted(k for k,v in indegree.items() if v == 0))
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for child in sorted(children[n]):
            indegree[child] -= 1
            if indegree[child] == 0: q.append(child)
    if len(order) != len(tasks):
        raise ValueError("Task dependency cycle detected.")
    collisions = []
    for i, a in enumerate(tasks):
        for b in tasks[i+1:]:
            if set(a.get("depends_on", [])) & {b["id"]} or set(b.get("depends_on", [])) & {a["id"]}:
                continue
            for sa in a.get("write_scopes", []):
                for sb in b.get("write_scopes", []):
                    if scopes_overlap(sa, sb):
                        collisions.append({"task_a":a["id"],"scope_a":sa,"task_b":b["id"],"scope_b":sb})
    return {
        "project_id": c["project"]["id"],
        "generated_at": now(),
        "task_order": order,
        "tasks": tasks,
        "parallel_write_scope_collisions": collisions,
        "warnings": ["Resolve all write-scope collisions before concurrent dispatch."] if collisions else []
    }

def atomic_write(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=p.name+".", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def init_state(c, path=None):
    state_path = path or c.get("state", {}).get("path", ".orchestrator/state.json")
    state = {
        "schema_version":"1.0",
        "project_id":c["project"]["id"],
        "created_at":now(),
        "updated_at":now(),
        "tasks":{t["id"]:{"status":"PLANNED","attempt":0,"milestone":t.get("milestone"),"implementer":t.get("implementer"),"reviewer":t.get("reviewer")} for t in c.get("tasks",[])},
        "milestones":{},
        "events":[]
    }
    for t in c.get("tasks", []):
        state["milestones"].setdefault(t.get("milestone","M0"), {"status":"PLANNED"})
    atomic_write(state_path, state)
    return state_path

def append_event(state, entity, entity_id, old, new, reason):
    state.setdefault("events", []).append({
        "timestamp":now(),"entity":entity,"id":entity_id,
        "from":old,"to":new,"reason":reason
    })
    state["updated_at"] = now()

def transition(state_path, entity, entity_id, target, reason):
    p = Path(state_path)
    state = json.loads(p.read_text(encoding="utf-8"))
    if entity == "task":
        records, rules = state["tasks"], TASK_STATES
    elif entity == "milestone":
        records, rules = state["milestones"], MILESTONE_STATES
    else:
        raise ValueError("entity must be task or milestone")
    if entity_id not in records: raise ValueError(f"Unknown {entity}: {entity_id}")
    old = records[entity_id]["status"]
    if target not in rules.get(old, set()):
        raise ValueError(f"Illegal {entity} transition: {old} -> {target}")
    records[entity_id]["status"] = target
    append_event(state, entity, entity_id, old, target, reason)
    atomic_write(p, state)
    return state

def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True)

def worktree_add(repo, branch, base, path):
    repo, path = Path(repo).resolve(), Path(path).resolve()
    if path.exists(): raise ValueError(f"Worktree path already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    check = git(repo, "rev-parse", "--is-inside-work-tree")
    if check.returncode: raise ValueError(check.stderr.strip() or "Not a Git repository")
    result = git(repo, "worktree", "add", "-b", branch, str(path), base)
    if result.returncode: raise ValueError(result.stderr.strip())
    return result.stdout.strip()

def worktree_list(repo):
    r = git(repo, "worktree", "list", "--porcelain")
    if r.returncode: raise ValueError(r.stderr.strip())
    return r.stdout

def worktree_remove(repo, path, force_dirty=False):
    repo, path = Path(repo).resolve(), Path(path).resolve()
    if not path.exists(): raise ValueError(f"Worktree path does not exist: {path}")
    status = git(path, "status", "--porcelain")
    if status.returncode: raise ValueError("Unable to inspect worktree status")
    if status.stdout.strip() and not force_dirty:
        raise ValueError("Refusing to remove dirty worktree. Inspect/preserve changes first.")
    args = ["worktree", "remove"]
    if force_dirty: args.append("--force")
    args.append(str(path))
    r = git(repo, *args)
    if r.returncode: raise ValueError(r.stderr.strip())
    return r.stdout.strip() or "Worktree removed."

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("--config", required=True)
    p = sub.add_parser("plan"); p.add_argument("--config", required=True); p.add_argument("--out", required=True)
    i = sub.add_parser("init"); i.add_argument("--config", required=True); i.add_argument("--state")
    s = sub.add_parser("status"); s.add_argument("--state", required=True)
    t = sub.add_parser("transition"); t.add_argument("--state", required=True); t.add_argument("--entity", choices=["task","milestone"], required=True); t.add_argument("--id", required=True); t.add_argument("--to", required=True); t.add_argument("--reason", required=True)
    r = sub.add_parser("report"); r.add_argument("--state", required=True); r.add_argument("--out", required=True)
    wa = sub.add_parser("worktree-add"); wa.add_argument("--repo", required=True); wa.add_argument("--branch", required=True); wa.add_argument("--base", required=True); wa.add_argument("--path", required=True)
    wl = sub.add_parser("worktree-list"); wl.add_argument("--repo", required=True)
    wr = sub.add_parser("worktree-remove"); wr.add_argument("--repo", required=True); wr.add_argument("--path", required=True); wr.add_argument("--force-dirty", action="store_true")
    a = ap.parse_args()
    try:
        if a.cmd == "validate":
            c=load_config(a.config); errors=validate_config(c)
            if errors: print("\n".join("ERROR: "+e for e in errors)); return 2
            print("Configuration valid."); return 0
        if a.cmd == "plan":
            c=load_config(a.config); errors=validate_config(c)
            if errors: raise ValueError("; ".join(errors))
            plan=build_plan(c); atomic_write(a.out,plan)
            print(f"Plan written to {a.out}; {len(plan['task_order'])} tasks.")
            if plan["parallel_write_scope_collisions"]: print("WARNING: write-scope collisions found.")
            return 0
        if a.cmd == "init":
            c=load_config(a.config); errors=validate_config(c)
            if errors: raise ValueError("; ".join(errors))
            p=init_state(c,a.state); print(f"Initialized state: {p}"); return 0
        if a.cmd == "status":
            st=json.loads(Path(a.state).read_text(encoding="utf-8"))
            print(json.dumps({"project_id":st["project_id"],"updated_at":st["updated_at"],"tasks":st["tasks"],"milestones":st["milestones"]},indent=2)); return 0
        if a.cmd == "transition":
            st=transition(a.state,a.entity,a.id,a.to,a.reason)
            print(f"{a.entity} {a.id}: {a.to}; state persisted."); return 0
        if a.cmd == "report":
            st=json.loads(Path(a.state).read_text(encoding="utf-8"))
            lines=[f"# Execution report: {st['project_id']}","",f"Updated: {st['updated_at']}","","## Tasks"]
            for tid,rec in st["tasks"].items(): lines.append(f"- **{tid}**: {rec['status']} (attempt {rec['attempt']})")
            lines += ["","## Milestones"]
            for mid,rec in st["milestones"].items(): lines.append(f"- **{mid}**: {rec['status']}")
            lines += ["","## Event history"]
            for e in st.get("events",[]): lines.append(f"- {e['timestamp']} — {e['entity']} {e['id']}: {e['from']} → {e['to']} — {e['reason']}")
            Path(a.out).parent.mkdir(parents=True,exist_ok=True); Path(a.out).write_text("\n".join(lines)+"\n",encoding="utf-8")
            print(f"Report written to {a.out}"); return 0
        if a.cmd == "worktree-add":
            print(worktree_add(a.repo,a.branch,a.base,a.path)); return 0
        if a.cmd == "worktree-list":
            print(worktree_list(a.repo)); return 0
        if a.cmd == "worktree-remove":
            print(worktree_remove(a.repo,a.path,a.force_dirty)); return 0
    except Exception as e:
        print(f"ERROR: {e}",file=sys.stderr); return 1

if __name__ == "__main__":
    sys.exit(main())
