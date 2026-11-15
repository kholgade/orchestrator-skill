import importlib.util, json, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "orchestrator.py"
spec = importlib.util.spec_from_file_location("orch", SCRIPT)
orch = importlib.util.module_from_spec(spec); spec.loader.exec_module(orch)

class OrchestratorTests(unittest.TestCase):
    def sample(self):
        return {
            "project":{"id":"test","repository":"."},
            "sources":{}, "agents":[
                {"id":"impl","role":"implementer"},
                {"id":"rev","role":"reviewer"}
            ],
            "tasks":[
                {"id":"A","milestone":"M0","title":"A","goal":"a","acceptance_criteria":["a"],"implementer":"impl","reviewer":"rev","depends_on":[],"write_scopes":["src/a"]},
                {"id":"B","milestone":"M0","title":"B","goal":"b","acceptance_criteria":["b"],"implementer":"impl","reviewer":"rev","depends_on":["A"],"write_scopes":["src/b"]}
            ],
            "execution":{"max_parallel_tasks":2,"max_parallel_agents":2,"max_rework_rounds":2},
            "git":{},"verification":{},"approvals":{},"state":{},"delivery":{}
        }

    def test_valid_config(self):
        self.assertEqual([], orch.validate_config(self.sample()))

    def test_reviewer_must_be_independent(self):
        c=self.sample(); c["tasks"][0]["reviewer"]="impl"
        self.assertTrue(any("reviewer must differ" in e for e in orch.validate_config(c)))

    def test_topological_plan(self):
        p=orch.build_plan(self.sample())
        self.assertEqual(["A","B"],p["task_order"])

    def test_cycle_rejected(self):
        c=self.sample(); c["tasks"][0]["depends_on"]=["B"]
        with self.assertRaises(ValueError): orch.build_plan(c)

    def test_write_scope_collision(self):
        c=self.sample(); c["tasks"][1]["depends_on"]=[]
        c["tasks"][1]["write_scopes"]=["src"]
        p=orch.build_plan(c)
        self.assertTrue(p["parallel_write_scope_collisions"])

    def test_transition_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.json"
            st={"project_id":"x","updated_at":"","tasks":{"A":{"status":"PLANNED"}},"milestones":{},"events":[]}
            p.write_text(json.dumps(st))
            with self.assertRaises(ValueError): orch.transition(p,"task","A","PASS","skip")
            orch.transition(p,"task","A","READY","deps pass")
            self.assertEqual("READY",json.loads(p.read_text())["tasks"]["A"]["status"])

if __name__ == "__main__": unittest.main()
