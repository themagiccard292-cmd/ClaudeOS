import os

SH_RM = "safe_rm_rf {} {}"


def test_safe_rm_rf_deletes_below_base(sh, tmp_path):
    d = tmp_path / "w" / "a"
    d.mkdir(parents=True)
    (d / "f").write_text("x")
    r = sh(f"safe_rm_rf {tmp_path / 'w'} {d}")
    assert r.returncode == 0 and not d.exists()


def test_safe_rm_rf_refuses_dangerous(sh, tmp_path):
    keep = tmp_path / "keep"
    keep.mkdir()
    for base, path in [("", str(keep)), (str(tmp_path), ""), ("/", "/"), ("/usr", "/usr/lib"),
                       (str(tmp_path / "x"), str(keep)), (str(tmp_path), "/"), (os.path.expanduser("~"), str(keep))]:
        r = sh(f'safe_rm_rf "{base}" "{path}"')
        assert r.returncode != 0, (base, path)
    assert keep.exists()


def test_safe_rm_rf_refuses_symlink_escape(sh, tmp_path):
    base = tmp_path / "w"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (base / "link").symlink_to(outside)
    assert sh(f"safe_rm_rf {base} {base / 'link'}").returncode != 0
    assert outside.exists()


def test_run_dry_run_prints_and_does_nothing(sh, tmp_path):
    r = sh(f"DRY_RUN=1; run touch {tmp_path / 'nope'}; run_to {tmp_path / 'o'} echo hi")
    assert r.returncode == 0 and "+ touch" in r.stdout
    assert not (tmp_path / "nope").exists() and not (tmp_path / "o").exists()


def test_stamps_and_run_stage(sh, tmp_path):
    r = sh("f(){ echo ran; }; run_stage 1 one f; run_stage 1 one f")
    assert r.stdout.count("ran") == 1 and "already completed" in r.stderr


def test_path_is_under(sh):
    assert sh("path_is_under /a/b /a/b/c").returncode == 0
    assert sh("path_is_under /a/b /a/bc").returncode != 0


def test_unmount_all_reverse_order(sh):
    r = sh('unmount_one(){ echo "un $1"; }; CLAUDEOS_MOUNTS=(/m/1 /m/2 /m/3); unmount_all')
    assert r.stdout.split("\n")[:3] == ["un /m/3", "un /m/2", "un /m/1"]
