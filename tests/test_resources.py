import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import resource_metrics as rm


def raw(at=1700000000):
    return {"at": at, "monotonic": at, "boot": "boot-one",
            "cpu": {"cpu": [100, 0, 100, 800, 0, 0, 0, 0], "cpu0": [100, 0, 100, 800, 0, 0, 0, 0]},
            "memory": {"MemTotal": 1024 * 1024, "MemAvailable": 512 * 1024},
            "vm": {"pswpin": 100, "pswpout": 200},
            "pressure": {"cpu": 0, "memory": 0, "io": 0},
            "disks": {"8:0": {"name": "sda", "reads": 10, "writes": 20, "read_sectors": 100,
                                "write_sectors": 100, "read_ms": 100, "write_ms": 100, "busy_ms": 20}},
            "mounts": [{"mount": "/data", "io_device_id": "8:0"}]}


def advance(before, seconds=15):
    after = copy.deepcopy(before)
    after["at"] += seconds; after["monotonic"] += seconds
    for k in after["cpu"]:
        after["cpu"][k][0] += 25
        after["cpu"][k][3] += 75
    return after


class Measurements(unittest.TestCase):
    def test_cpu_guest_not_double_counted_and_memory_uses_available(self):
        parsed = rm.parse_cpu("cpu 100 0 100 800 0 0 0 0 70 0\ncpu0 100 0 100 800 0 0 0 0 70 0")
        self.assertEqual(sum(parsed["cpu"]), 1000)
        before=raw(); after=advance(before)
        result=rm.derive(after,before,[],[])
        self.assertEqual(result["values"]["cpu_pct"],25)
        self.assertEqual(result["values"]["ram_pct"],50)
        self.assertEqual(result["values"]["ram_available_gib"],0.5)

    def test_missing_boot_reset_and_long_gap_do_not_fabricate_zero(self):
        before=raw(); after=advance(before)
        for previous,current in [(None,after),(before,{**after,"boot":"new-boot"}),(before,advance(before,90))]:
            v=rm.derive(current,previous,None,[])
            self.assertEqual(v["duration"],0)
            self.assertIsNone(v["values"]["cpu_pct"])
            self.assertIsNone(v["values"]["swap_mib_s"])
            self.assertIsNone(v["values"]["allocated_gpus"])
        after["cpu"]["cpu"][0]=0
        self.assertIsNone(rm.derive(after,before,[],[])["values"]["cpu_pct"])
        after["pressure"]["io"]=None
        self.assertIsNone(rm.derive(after,before,[],[])["values"]["io_psi_pct"])

    def test_io_sector_units_request_weighting_and_swap(self):
        before=raw(); after=advance(before)
        after["disks"]["8:0"].update(reads=13,writes=22,read_sectors=30820,write_sectors=15460,read_ms=150,write_ms=150)
        after["vm"]["pswpin"]+=3840
        after["pressure"]["io"]=1500000
        d=rm.derive(after,before,[],[])
        self.assertEqual(d["devices"][0]["latency_ms"],20)
        self.assertEqual(d["devices"][0]["read_mib_s"],1)
        self.assertEqual(d["devices"][0]["write_mib_s"],0.5)
        self.assertEqual(d["values"]["swap_mib_s"],1)
        self.assertEqual(d["values"]["io_psi_pct"],10)

    def test_allocation_deduplicates_gpus_excludes_api_and_planned(self):
        gpus=[{"uuid":"gpu0","utilization":20,"memory_used_mib":500,"memory_total_mib":1000}]
        jobs=[{"status":"running","gpu_uuids":["gpu0"]},{"status":"running","gpu_uuids":["gpu0"]},
              {"status":"planned","gpu_uuids":["gpu0"]},{"status":"running","resource_type":"api","gpu_uuids":["gpu0"]}]
        v=rm.derive(advance(raw()),raw(),gpus,jobs)["values"]
        self.assertEqual(v["allocated_gpus"],1)
        self.assertEqual(v["local_gpu_jobs"],2)
        self.assertEqual(v["api_jobs"],1)
        self.assertEqual(v["vram_pct"],50)
        api=rm.derive(advance(raw()),raw(),gpus,[jobs[-1]])["values"]
        self.assertEqual(api["allocated_gpus"],0)
        self.assertIsNone(api["gpu_active_pct"])
        self.assertFalse(any(rm.candidates(api).values()))

    def test_local_mounts_only_no_network_or_duplicate_filesystems(self):
        text="24 1 8:1 / / rw - ext4 /dev/sda1 rw\n25 1 8:1 /home /home rw - ext4 /dev/sda1 rw\n26 1 0:2 / /nfs rw - nfs host:/data rw\n27 1 0:3 / /fuse rw - fuse.sshfs host rw\n28 1 8:2 / /data\\040disk rw - xfs /dev/sda2 rw"
        self.assertEqual([m["mount"] for m in rm.mount_entries(text)],["/","/data disk"])


class History(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.sampler=rm.ResourceSampler({"state_dir":self.temp.name})

    def tearDown(self):
        self.temp.cleanup()

    def test_bucket_boundaries_weight_missing_values_separately(self):
        self.sampler.add_history({"at":600,"duration":20,"values":{"cpu_pct":50}})
        self.sampler.add_history({"at":615,"duration":15,"values":{"cpu_pct":100,"gpu_pct":20}})
        self.assertEqual(len(self.sampler.fine),2)
        cpu=[k for k,_ in rm.COLUMNS].index("cpu_pct"); gpu=0
        self.assertEqual(self.sampler.fine[0][1],20)
        self.assertEqual(self.sampler.fine[1][1],15)
        self.assertEqual(self.sampler.hourly[0][2][cpu],(20*50+15*100)/35)
        self.assertEqual(self.sampler.hourly[0][2][gpu],20)
        self.assertEqual(self.sampler.hourly[0][3][gpu],15)

    def test_sustained_events_reset_on_missing_samples(self):
        values={"ram_pct":98,"swap_mib_s":3,"memory_psi_pct":10,"local_gpu_jobs":1}
        for at in range(15,120,15):self.sampler.add_events({"at":at,"duration":15,"values":values})
        self.assertEqual(self.sampler.events,[])
        self.sampler.add_events({"at":120,"duration":15,"values":values})
        self.assertEqual(len(self.sampler.events),1)
        self.sampler.add_events({"at":300,"duration":0,"values":values})
        self.sampler.add_events({"at":315,"duration":15,"values":values})
        self.assertEqual(self.sampler.events[0]["end"],120)
        self.assertEqual(len(self.sampler.events),1)

    def test_restore_rejects_missing_value_with_positive_weight(self):
        now=1700000000
        self.sampler.add_history({"at":now,"duration":15,"values":{"cpu_pct":50}})
        row=copy.deepcopy(self.sampler.fine[0])
        row[2][2]=None
        with patch.object(rm.time,"time",return_value=now):
            self.assertEqual(rm.ResourceSampler.valid_rows([row],300,rm.DAY),[])

    def test_history_retention_and_restart_do_not_fill_downtime(self):
        now=1700000000
        with patch.object(rm.time,"time",return_value=now):
            self.sampler.add_history({"at":now-31*rm.DAY,"duration":15,"values":{"cpu_pct":10}})
            self.sampler.add_history({"at":now,"duration":15,"values":{"cpu_pct":50}})
            self.assertEqual(len(self.sampler.fine),1)
            self.assertEqual(len(self.sampler.hourly),1)
            self.sampler.save()
            restored=rm.ResourceSampler({"state_dir":self.temp.name})
            self.assertEqual(restored.fine,self.sampler.fine)
            result=restored.observe(raw(now+1000),[],[])
            self.assertEqual(result["duration"],0)
            self.assertEqual(sum(r[1] for r in restored.fine),15)

    def test_public_data_has_no_raw_counters_or_process_identifiers(self):
        self.sampler.observe(raw(),[],[{"status":"running","gpu_uuids":[],"_pid":123,"_owner_uid":1001,"name":"private"}])
        public=json.dumps(self.sampler.public())
        for private in ("private","_owner_uid","_pid","boot-one","pswpin"):
            self.assertNotIn(private,public)


if __name__ == '__main__':unittest.main()
