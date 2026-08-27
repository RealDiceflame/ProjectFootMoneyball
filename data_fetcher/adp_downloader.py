"""
adp_downloader.py – Downloads the latest ADP CSV from 4for4.com using Selenium

This script:
- Launches a headless Chrome browser
- Navigates to the ADP page
- Clicks the CSV download link
- Renames and moves the file into the specified output directory
"""

import os
import time
import shutil
from selenium import webdriver
from selenium.webdriver.chrome.options import Options


def download_4for4_adp_csv(download_dir="output"):
    """
    Automates downloading the ADP CSV from 4for4.com using headless Chrome.

    Args:
        download_dir (str): Directory to save the CSV to. Defaults to "output".

    Returns:
        str | None: Path to the saved CSV, or None if download failed.
    """
    os.makedirs(download_dir, exist_ok=True)

    # Set up headless Chrome with download preferences
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--disable-gpu")
    prefs = {
        "download.default_directory": os.path.abspath(download_dir),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    }
    options.add_experimental_option("prefs", prefs)

    driver = webdriver.Chrome(options=options)
    driver.get("https://www.4for4.com/adp")

    time.sleep(5)  # Wait for page load

    try:
        download_button = driver.find_element("xpath", "//a[contains(@href, '.csv')]")
        download_button.click()
        print("📥 Download started...")
        time.sleep(10)  # Wait for download to complete
    except Exception as e:
        print(f"❌ Error during download: {e}")
    finally:
        driver.quit()

    for filename in os.listdir(download_dir):
        if filename.endswith(".csv") and "adp" in filename.lower():
            src = os.path.join(download_dir, filename)
            dst = os.path.join(download_dir, "adp_4for4.csv")
            shutil.move(src, dst)
            print(f"✅ ADP file saved as {dst}")
            return dst

    print("⚠️ ADP CSV not found after download.")
    return None
