from app.desktop import format_table_value


def test_numeric_display_handles_missing_markers_without_stopping_render():
    assert format_table_value("adp", "-") == ""
    assert format_table_value("Yahoo", None) == ""
    assert format_table_value("projected_points", float("nan")) == ""
    assert format_table_value("vorp", "12.345") == "12.3"
    assert format_table_value("source_count", 5.0) == "5"


def test_drafted_display_uses_marker_only_when_selected():
    assert format_table_value("drafted", False) == ""
    assert format_table_value("drafted", True) == "✓"
