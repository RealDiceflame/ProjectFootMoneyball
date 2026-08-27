"""
data_fetcher.py – Generic Data Fetching Utility

Supports downloading and parsing:
- CSV, JSON, Excel, XML, plain text
- HTML tables (via pandas.read_html)

Includes optional scheduling support via `schedule` module.
"""

import os
import time
import logging
import requests
import pandas as pd
from io import StringIO, BytesIO
import schedule


class DataFetcher:
    """
    A generic data fetcher that supports CSV, JSON, Excel, XML, and HTML sources.
    Optionally saves to disk and can be scheduled to run daily.
    """

    def __init__(self, url, save_path=None, schedule_time=None):
        self.url = url
        self.save_path = save_path
        self.schedule_time = schedule_time
        self.data = None

    def fetch_data(self):
        """
        Downloads data from the provided URL and infers format based on content type.
        Saves to file if `save_path` is set.
        """
        try:
            response = requests.get(self.url, timeout=10)
            response.raise_for_status()

            content_type = response.headers.get('Content-Type', '').lower()

            if 'csv' in content_type:
                self.data = pd.read_csv(StringIO(response.text))
            elif 'json' in content_type:
                self.data = pd.read_json(StringIO(response.text))
            elif 'excel' in content_type or 'spreadsheet' in content_type:
                self.data = pd.read_excel(BytesIO(response.content))
            elif 'xml' in content_type:
                self.data = pd.read_xml(StringIO(response.text))
            elif 'text/plain' in content_type:
                self.data = pd.DataFrame([line.split() for line in response.text.splitlines()])
            elif 'html' in content_type or self.url.endswith(('.htm', '.html')):
                self.data = self._parse_html_tables()
            else:
                raise ValueError(f"Unsupported content type: {content_type}")

            if self.data is None or self.data.empty:
                raise ValueError("Fetched data is empty.")

            logging.info("Data fetched successfully.")
            if self.save_path:
                os.makedirs(os.path.dirname(self.save_path), exist_ok=True)
                self.save_data()

        except requests.exceptions.RequestException as e:
            logging.error(f"Failed to fetch data: {e}")
            raise ValueError(f"Failed to fetch data: {e}")

    def _parse_html_tables(self):
        """
        Parses HTML tables from the URL using pandas.read_html().
        Returns the first table found or an empty DataFrame.
        """
        try:
            tables = pd.read_html(self.url)
            if tables:
                logging.info(f"Found {len(tables)} table(s) on the HTML page.")
                return tables[0]
            logging.warning("No HTML tables found on page.")
            return pd.DataFrame()
        except Exception as e:
            logging.error(f"Error parsing HTML tables: {e}")
            raise

    def get_data(self):
        """
        Returns the fetched DataFrame. Raises if data has not been fetched yet.
        """
        if self.data is None:
            raise ValueError("Data has not been fetched yet. Call fetch_data() first.")
        return self.data

    def save_data(self):
        """
        Saves the fetched DataFrame to disk in the appropriate format
        based on file extension.
        """
        if self.data is not None and self.save_path:
            file_ext = os.path.splitext(self.save_path)[1].lower()
            try:
                if file_ext == ".csv":
                    self.data.to_csv(self.save_path, index=False, na_rep='-')
                elif file_ext == ".json":
                    self.data.to_json(self.save_path, orient='records', indent=4)
                elif file_ext in [".xlsx", ".xls"]:
                    self.data.to_excel(self.save_path, index=False)
                elif file_ext == ".xml":
                    self.data.to_xml(self.save_path, index=False)
                else:
                    raise ValueError("Unsupported file format for saving data.")
                logging.info(f"Data saved successfully to {self.save_path}.")
            except Exception as e:
                logging.error(f"Failed to save data: {e}")
                raise ValueError(f"Failed to save data: {e}")

    def schedule_fetching(self):
        """
        If schedule_time is set (e.g., "02:00"), run fetch_data() daily at that time.
        """
        if self.schedule_time:
            schedule.every().day.at(self.schedule_time).do(self.fetch_data)
            logging.info(f"Scheduled data fetching daily at {self.schedule_time}.")
            while True:
                schedule.run_pending()
                time.sleep(60)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
