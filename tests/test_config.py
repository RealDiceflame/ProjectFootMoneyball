import config


def test_packaged_data_is_seeded_without_overwriting_user_updates(tmp_path, monkeypatch):
    bundle_root = tmp_path / "bundle"
    data_dir = tmp_path / "user" / "data"
    source = bundle_root / "data" / "ADP" / "snapshot.csv"
    source.parent.mkdir(parents=True)
    source.write_text("bundled", encoding="utf-8")

    monkeypatch.setattr(config, "IS_FROZEN", True)
    monkeypatch.setattr(config, "BUNDLE_ROOT", bundle_root)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    config.seed_packaged_data()

    destination = data_dir / "ADP" / "snapshot.csv"
    assert destination.read_text(encoding="utf-8") == "bundled"
    destination.write_text("user update", encoding="utf-8")
    config.seed_packaged_data()
    assert destination.read_text(encoding="utf-8") == "user update"
