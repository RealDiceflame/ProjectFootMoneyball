from unittest.mock import patch

from app.platform_utils import open_file


def test_open_file_uses_macos_open(tmp_path):
    document = tmp_path / "board.xlsx"
    with patch("app.platform_utils.sys.platform", "darwin"), \
            patch("app.platform_utils.subprocess.Popen") as popen:
        open_file(document)
    popen.assert_called_once_with(["open", str(document.resolve())])
