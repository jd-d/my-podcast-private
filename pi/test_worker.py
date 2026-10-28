"""Behavioral Pi tests. No network calls or real media downloads."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("podcast_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_url_restrictions(self):
        worker.check_video_url("https://youtu.be/synthetic")
        for url in ["http://youtu.be/a", "https://youtube.com.evil.test/a", "https://user:password@youtube.com/a", "https://127.0.0.1/a"]:
            with self.assertRaises(ValueError):
                worker.check_video_url(url)

    def test_local_lease_expires_without_network(self):
        with patch.object(worker.time, "monotonic", return_value=100):
            guard = worker.LeaseGuard()
        with patch.object(worker.time, "monotonic", return_value=1840):
            with self.assertRaises(worker.LeaseLost):
                guard.check()
        self.assertTrue(guard.lost.is_set())

    def test_renewal_uses_request_start_not_finish(self):
        guard = worker.LeaseGuard()
        guard.renew(100)
        self.assertEqual(guard.deadline,1840)

    def test_definitive_heartbeat_rejection_loses_lease(self):
        for code in [401,403,409]:
            stop = Mock()
            stop.wait.return_value = False
            guard = worker.LeaseGuard()
            with patch.object(worker,"request_api", side_effect=urllib.error.HTTPError("https://example.test",code,"synthetic",{},None)):
                worker.keep_lease(stop,guard,"https://example.test","synthetic","id","lease")
            self.assertTrue(guard.lost.is_set())

    def test_transient_heartbeat_failure_does_not_extend_deadline(self):
        stop = Mock()
        stop.wait.side_effect = [False,True]
        guard = worker.LeaseGuard()
        deadline = guard.deadline
        with patch.object(worker,"request_api",side_effect=TimeoutError):
            worker.keep_lease(stop,guard,"https://example.test","synthetic","id","lease")
        self.assertEqual(guard.deadline,deadline)
        self.assertFalse(guard.lost.is_set())

    def test_lost_lease_terminates_subprocess(self):
        guard = worker.LeaseGuard()
        guard.lost.set()
        started = time.monotonic()
        with self.assertRaises(worker.LeaseLost):
            worker.execute([sys.executable,"-c","import time; time.sleep(15)"],timeout=30,guard=guard)
        self.assertLess(time.monotonic()-started,6)

    def test_node_runtime_is_explicit_and_m4a_passes_through(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            audio = directory/"synthetic.m4a"
            def download(args, **kwargs):
                self.assertEqual(args[args.index("--js-runtimes")+1],"node")
                self.assertIn("--ignore-config",args)
                audio.write_bytes(b"synthetic")
                return str(audio)
            with patch.dict(os.environ,{"YTDLP_JS_RUNTIME":"node"}), patch.object(worker,"execute",side_effect=download) as execute:
                result,_ = worker.prepare_audio("https://youtu.be/synthetic",directory,1)
            self.assertEqual(result,audio)
            self.assertEqual(execute.call_count,1)

    def test_conversion_cannot_publish_oversized_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory/"synthetic.opus"
            def tool(args, **kwargs):
                if args[0]=="ffmpeg":
                    (directory/"audio.m4a").write_bytes(b"x"*(1024*1024+1))
                    self.assertEqual(kwargs["output_limit"],(directory/"audio.m4a",1024*1024))
                    return ""
                source.write_bytes(b"synthetic")
                return str(source)
            with patch.object(worker,"execute",side_effect=tool):
                with self.assertRaisesRegex(RuntimeError,"exceeds configured size"):
                    worker.prepare_audio("https://youtu.be/synthetic",directory,1)

    def test_insufficient_disk_is_rejected_before_downloading(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(worker.shutil,"disk_usage",return_value=Mock(free=10)), patch.object(worker,"execute") as execute:
            with self.assertRaisesRegex(RuntimeError,"Insufficient"):
                worker.prepare_audio("https://youtu.be/synthetic",Path(directory),1)
            execute.assert_not_called()

    def test_startup_checks_node_version(self):
        with patch.dict(os.environ,{"YTDLP_JS_RUNTIME":"node"}), patch.object(worker.shutil,"which",return_value="synthetic"), patch.object(worker,"execute",return_value="v20.0.0"):
            with self.assertRaisesRegex(RuntimeError,"too old"):
                worker.check_tools()
        with patch.dict(os.environ,{"YTDLP_JS_RUNTIME":"node"}), patch.object(worker.shutil,"which",return_value="synthetic"), patch.object(worker,"execute",return_value="v22.0.0"):
            worker.check_tools()

    def test_upload_uses_attempt_namespace_and_lease_callback(self):
        guard = worker.LeaseGuard()
        env={name:"synthetic" for name in ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]}
        with patch.dict(os.environ,env), patch.object(worker.boto3,"client") as client:
            key,mime=worker.upload_to_r2(Path("synthetic.m4a"),"imports/job/attempt",guard)
        self.assertEqual(key,"imports/job/attempt/audio.m4a")
        self.assertEqual(mime,"audio/mp4")
        self.assertEqual(client.return_value.upload_file.call_args.kwargs["Callback"],guard.check)

    def test_lease_loss_before_upload_never_uploads(self):
        job={"id":"00000000-0000-4000-8000-000000000001","lease":"synthetic","url":"https://youtu.be/synthetic","upload_prefix":"imports/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002"}
        def download(url,directory,maximum,guard):
            guard.lost.set()
            return Path("synthetic.m4a"),{}
        with patch.object(worker.threading,"Thread"), patch.object(worker,"prepare_audio",side_effect=download), patch.object(worker,"upload_to_r2") as upload, patch.object(worker,"request_api",return_value={"ok":True}):
            worker.process_job(job,"https://example.test","synthetic",1)
        upload.assert_not_called()


if __name__=="__main__":
    unittest.main()
